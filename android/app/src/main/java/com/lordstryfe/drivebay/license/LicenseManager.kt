package com.lordstryfe.drivebay.license

import org.json.JSONObject

object LicenseConfig {
    /** Ed25519 public keys (hex) that may sign licenses and receipts. The private key lives only on the license server. */
    val PUBLIC_KEYS_HEX = listOf("c9258c6b8c94fd949294d39bcd31cbc40b4a11219d762183c340465d83c35010")
    const val API = "https://mesaandmoon.com/drivebay/api/license.php"
    const val UPGRADE_URL = "https://mesaandmoon.com/drivebay/upgrade/"
    const val REFRESH_EVERY_SECONDS = 7 * 86400L
    fun publicKeys(): List<ByteArray> = PUBLIC_KEYS_HEX.map { LicenseCodec.hexToBytes(it) }
}

data class LicenseRecord(val key: String, val receipt: String, val lastCheckAt: Long, val lastError: String = "")

interface LicenseStorage {
    fun load(): LicenseRecord?
    fun save(record: LicenseRecord)
    fun clear()
}

data class HttpReply(val status: Int, val json: JSONObject?, val network: Boolean = false)

interface LicenseHttp {
    fun post(action: String, body: JSONObject): HttpReply
}

data class EditionState(
    val edition: String,
    val status: String,
    val detail: String,
    val license: License?,
    val needsRefresh: Boolean,
    val receiptValidUntil: Long?,
) {
    val name: String get() = EditionPolicy.NAMES.getValue(edition)
    fun can(feature: String) = EditionPolicy.allows(edition, feature)
}

data class ActionResult(val ok: Boolean, val message: String, val code: String = "", val devices: List<String> = emptyList(), val offline: Boolean = false, val released: Boolean = false)

/** Judge, activate, refresh and deactivate a license on the phone. Blocking: call activate/refresh/deactivate off the main thread. */
class LicenseManager(
    private val storage: LicenseStorage,
    private val http: LicenseHttp,
    private val machineId: () -> String,
    private val deviceName: () -> String,
    private val appVersion: String,
    private val buildTs: Long,
    private val publicKeys: List<ByteArray> = LicenseConfig.publicKeys(),
    private val clock: () -> Long = { System.currentTimeMillis() / 1000 },
) {
    fun state(now: Long = clock()): EditionState {
        val free = EditionState("free", "none", "", null, false, null)
        val record = storage.load() ?: return free
        val check = LicenseCodec.verifyKey(record.key, publicKeys)
        if (!check.ok) return free.copy(status = "invalid", detail = "The stored license did not verify, so Drivebay is running as Free.")
        val license = check.license!!
        when (LicenseCodec.state(license, now, buildTs)) {
            "expired" -> return free.copy(status = "expired", license = license, detail = "Your ${EditionPolicy.NAMES[license.edition]} license expired. Everything you own still works; paid features are off until you renew.")
            "updates_ended" -> return free.copy(status = "updates_ended", license = license, detail = "Your updates ended before this version was released. This build runs as Free. Renew updates, or install a version released before your updates ended.")
        }
        var validUntil: Long? = null
        if (!license.offline) {
            if (record.lastError in setOf("revoked", "unknown_license", "unknown_code", "code_disabled")) {
                return free.copy(status = "revoked", license = license, detail = "This license was revoked, so Drivebay is running as Free. Write to support if you think that is a mistake.")
            }
            val receipt = if (record.receipt.isBlank()) ReceiptCheck(false, "missing") else LicenseCodec.verifyReceipt(record.receipt, machineId(), publicKeys, now)
            if (!receipt.ok) {
                val lapsed = receipt.error == "receipt_expired" || receipt.error == "missing"
                return free.copy(
                    status = "needs_online",
                    license = license,
                    needsRefresh = true,
                    detail = if (lapsed) "Drivebay needs to check in with the license server. Connect to the internet and press Refresh." else "This license is not activated for this phone. Press Activate again.",
                )
            }
            validUntil = receipt.validUntil
        }
        return EditionState(license.edition, "active", "", license, !license.offline && now >= record.lastCheckAt + LicenseConfig.REFRESH_EVERY_SECONDS, validUntil)
    }

    private fun body(key: String) = JSONObject()
        .put("key", key)
        .put("machineId", machineId())
        .put("name", deviceName())
        .put("platform", "phone")
        .put("appVersion", appVersion)

    fun activate(input: String): ActionResult {
        val now = clock()
        val text = LicenseCodec.extractKeyInput(input)
        val kind = LicenseCodec.classify(text)
        if (kind.isEmpty()) return ActionResult(false, "That does not look like a Drivebay purchase code (DBAY-XXXX-XXXX-XXXX-XXXX) or license key.", "format")
        if (kind == "long") {
            val local = LicenseCodec.verifyKey(text, publicKeys)
            if (!local.ok) return ActionResult(false, "That license key did not verify. Check it for typos, or ask for a new one.", "bad_signature")
            if (LicenseCodec.state(local.license!!, now) == "expired") return ActionResult(false, "That license has expired.", "expired")
            if (local.license.offline) {
                storage.save(LicenseRecord(text.filter { !it.isWhitespace() }, "", now))
                return ActionResult(true, "License file accepted.", offline = true)
            }
        }
        val reply = http.post("activate", body(text))
        if (reply.network) return ActionResult(false, "Could not reach the license server. Check your connection and try again.", "network")
        val json = reply.json
        if (reply.status !in 200..299 || json == null) {
            val devices = json?.optJSONArray("devices")?.let { arr -> (0 until arr.length()).map { arr.getJSONObject(it).optString("name").ifBlank { "a device" } } } ?: emptyList()
            return ActionResult(false, json?.optString("error").orEmpty().ifBlank { "The license server said no." }, json?.optString("code").orEmpty(), devices)
        }
        val key = json.optString("licenseKey")
        val receipt = json.optString("receipt")
        val verified = LicenseCodec.verifyKey(key, publicKeys)
        val receiptOk = LicenseCodec.verifyReceipt(receipt, machineId(), publicKeys, now)
        if (!verified.ok || !receiptOk.ok) return ActionResult(false, "The license server's answer did not verify, so it was not saved.", "bad_server_answer")
        storage.save(LicenseRecord(key, receipt, now))
        return ActionResult(true, "Activated.")
    }

    fun refresh(): ActionResult {
        val record = storage.load() ?: return ActionResult(false, "No license is stored.", "none")
        val local = LicenseCodec.verifyKey(record.key, publicKeys)
        if (local.ok && local.license!!.offline) return ActionResult(true, "Offline license, nothing to refresh.", offline = true)
        val now = clock()
        val reply = http.post("refresh", body(record.key))
        if (reply.network) return ActionResult(false, "Could not reach the license server. Check your connection and try again.", "network")
        val json = reply.json
        if (reply.status !in 200..299 || json == null) {
            val code = json?.optString("code").orEmpty()
            if (code in setOf("revoked", "unknown_license", "unknown_code", "code_disabled", "expired")) {
                storage.save(record.copy(receipt = "", lastCheckAt = now, lastError = code))
            }
            return ActionResult(false, json?.optString("error").orEmpty().ifBlank { "The license server said no." }, code)
        }
        val receipt = json.optString("receipt")
        if (!LicenseCodec.verifyReceipt(receipt, machineId(), publicKeys, now).ok) return ActionResult(false, "The license server's answer did not verify.", "bad_server_answer")
        storage.save(LicenseRecord(record.key, receipt, now))
        return ActionResult(true, "License refreshed.")
    }

    fun deactivate(force: Boolean = false): ActionResult {
        val record = storage.load() ?: return ActionResult(true, "No license on this phone.")
        val local = LicenseCodec.verifyKey(record.key, publicKeys)
        if (local.ok && local.license!!.offline) {
            storage.clear()
            return ActionResult(true, "License removed from this phone.", offline = true)
        }
        val reply = http.post("deactivate", JSONObject().put("key", record.key).put("machineId", machineId()))
        if (reply.status in 200..299 && reply.json != null) {
            storage.clear()
            val released = reply.json.optBoolean("released")
            return ActionResult(true, if (released) "This phone was deactivated and the seat is free." else "License removed from this phone.", released = released)
        }
        if (force) {
            storage.clear()
            return ActionResult(true, "License removed from this phone. The seat frees up on its own after 120 days, or write to support.")
        }
        return ActionResult(false, reply.json?.optString("error").orEmpty().ifBlank { "Could not reach the license server." }, if (reply.network) "network" else reply.json?.optString("code").orEmpty().orEmpty())
    }
}
