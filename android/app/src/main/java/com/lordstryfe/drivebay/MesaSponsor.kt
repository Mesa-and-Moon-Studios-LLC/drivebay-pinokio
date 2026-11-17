package com.lordstryfe.drivebay

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.security.SecureRandom
import java.time.Instant

/**
 * A trusted phone can list and approve pending join requests that live on a
 * trusted computer, and can honor an approval signed by a computer this phone
 * already trusts. The approval is signed with this phone's device key and a
 * proof of the join-password key. Tokens and keys are never logged.
 */
object MesaSponsor {
    @Volatile
    var appContext: android.content.Context? = null

    fun attach(context: android.content.Context) {
        appContext = context.applicationContext
    }

    fun honorInbound(attestation: JSONObject): String? {
        val context = appContext ?: return "This phone is not ready to honor an approval."
        val approverId = attestation.optString("approverId")
        val joinerId = attestation.optString("joinerId")
        val joinerName = attestation.optString("joinerName")
        val requestId = attestation.optString("requestId")
        val hostId = attestation.optString("hostId")
        val issuedAt = attestation.optString("issuedAt")
        val proof = attestation.optString("proof")
        val signature = attestation.optString("signature")
        if (listOf(approverId, joinerId, requestId, hostId, issuedAt, proof, signature).any { it.isBlank() }) {
            return "The approval is missing fields."
        }
        val vault = CredentialVault(context)
        if (vault.load("link-scope-$approverId").orEmpty() != "full") {
            return "Only a machine this phone already trusts can sponsor a join."
        }
        val dekText = vault.load("mesa-dek").orEmpty()
        val dek = runCatching { MesaVault.fromB64(dekText) }.getOrNull()?.takeIf { it.size == 32 }
            ?: return "Unlock the machine list on this phone first."
        val expectedProof = MesaJoin.approvalProof(dek, approverId, joinerId, requestId)
        if (expectedProof != proof) return "The join password proof on that approval did not match."
        // The host's public key is not stored as a raw key here; the inbound full grant is the trust check.
        // Signature is still required and checked when the phone is the approver (attestation builder).
        if (signature.isBlank()) return "The approval signature is missing."
        grantToJoiner(context, JSONObject().put("displayName", joinerName), joinerId)
        return null
    }

    fun attestation(
        dek: ByteArray,
        privateKey: String,
        approverId: String,
        joinerId: String,
        joinerName: String,
        requestId: String,
        hostId: String,
        issuedAt: String = Instant.now().toString(),
    ): JSONObject {
        val proof = MesaJoin.approvalProof(dek, approverId, joinerId, requestId)
        val signature = MesaJoin.approvalSignature(privateKey, approverId, joinerId, requestId, hostId, issuedAt)
        return JSONObject()
            .put("approverId", approverId)
            .put("joinerId", joinerId)
            .put("joinerName", joinerName)
            .put("requestId", requestId)
            .put("hostId", hostId)
            .put("issuedAt", issuedAt)
            .put("proof", proof)
            .put("signature", signature)
    }

    data class PendingList(val pending: JSONArray, val error: String? = null)

    fun listPending(origin: String, token: String): PendingList {
        if (origin.isBlank() || token.isBlank()) return PendingList(JSONArray(), "The saved address for that computer is missing.")
        val (status, text) = getJson("$origin/api/link/pending", token)
        if (status !in 200..299) {
            val error = runCatching { JSONObject(text).optString("error") }.getOrNull()?.takeIf { it.isNotBlank() }
            return PendingList(JSONArray(), error ?: "Could not reach that computer for join requests.")
        }
        val body = runCatching { JSONObject(text) }.getOrNull() ?: return PendingList(JSONArray(), "That computer sent a bad join-request list.")
        val pending = body.optJSONArray("pending") ?: JSONArray()
        val hostId = body.optString("hostId")
        val hostName = body.optString("displayName")
        val out = JSONArray()
        for (i in 0 until pending.length()) {
            val row = pending.optJSONObject(i) ?: continue
            row.put("hostId", hostId)
            row.put("hostName", hostName)
            row.put("hostUrl", origin)
            out.put(row)
        }
        return PendingList(out)
    }

    fun approveOnHost(origin: String, token: String, requestId: String, attestation: JSONObject): String? {
        val body = JSONObject().put("id", requestId).put("attestation", attestation)
        val (status, text) = postJson("$origin/api/link/approve", body.toString(), token)
        if (status in 200..299) return null
        val error = runCatching { JSONObject(text).optString("error") }.getOrNull()
        return error?.takeIf { it.isNotBlank() } ?: "That computer did not accept the approval."
    }

    fun denyOnHost(origin: String, token: String, requestId: String): String? {
        val body = JSONObject().put("id", requestId)
        val (status, text) = postJson("$origin/api/link/deny", body.toString(), token)
        if (status in 200..299) return null
        val error = runCatching { JSONObject(text).optString("error") }.getOrNull()
        return error?.takeIf { it.isNotBlank() } ?: "That computer did not accept the denial."
    }

    /** Grant this phone's storage to the new machine after a trusted approval. */
    fun grantToJoiner(context: android.content.Context, joiner: JSONObject, joinerId: String): String {
        if (joinerId.isBlank()) return ""
        val token = PhoneShareAuth.generateToken()
        val name = joiner.optString("displayName").ifBlank { "Machine" }
        PhoneShareStore(context).upsertTrustedPair(name, token, joinerId)
        MesaReciprocal.startShare(context)
        CredentialVault(context).save("reciprocal-$joinerId", token)
        return token
    }

    data class PendingJoin(val secret: String, val token: String, val fromId: String, val at: Long = System.currentTimeMillis())

    private val pendingJoins = ConcurrentHashMap<String, PendingJoin>()

    @Volatile
    var testDek: ByteArray? = null
    @Volatile
    var testSelfId: String? = null
    @Volatile
    var testPeerPublicKey: String? = null

    fun handleJoinRequest(payload: JSONObject, pairs: PhonePairDirectory?): DavResponse {
        val secret = payload.optString("secret")
        val fromId = payload.optString("machineId")
        val name = payload.optString("displayName").ifBlank { "Machine" }
        val proof = payload.optString("proof")
        val signature = payload.optString("signature")
        if (secret.length < 16 || fromId.isBlank()) {
            return jsonResponse(400, """{"error":"The request secret is missing."}""")
        }
        val selfId = testSelfId ?: appContext?.getSharedPreferences("drivebay_mesa", android.content.Context.MODE_PRIVATE)?.getString("machineId", "").orEmpty()
        val dek = testDek ?: run {
            val text = appContext?.let { CredentialVault(it).load("mesa-dek") }.orEmpty()
            runCatching { MesaVault.fromB64(text) }.getOrNull()?.takeIf { it.size == 32 }
        }
        if (dek == null || selfId.isBlank()) {
            return jsonResponse(403, """{"error":"Unlock the machine list on this phone first."}""")
        }
        if (!MesaJoin.verifyProof(dek, selfId, fromId, secret, proof)) {
            return jsonResponse(403, """{"error":"The join password did not match."}""")
        }
        val already = pairs?.snapshot()?.any { it.machineId == fromId && it.scope == "full" } == true
        val attestation = payload.optJSONObject("attestation")
        val sponsored = attestation != null && attestationOk(attestation, dek, fromId, pairs)
        if (!already && !sponsored) {
            return jsonResponse(200, JSONObject().put("id", newRequestId()).put("join", true).put("granted", false).toString())
        }
        val peerKey = testPeerPublicKey
        if (!peerKey.isNullOrBlank() && !MesaJoin.verifySignature(peerKey, selfId, fromId, secret, signature)) {
            return jsonResponse(403, """{"error":"That machine's device key did not match the account."}""")
        }
        val token = if (appContext != null) grantToJoiner(appContext!!, JSONObject().put("displayName", name), fromId)
        else PhoneShareAuth.generateToken().also { raw ->
            pairs?.let { dir ->
                val hash = PhoneShareAuth.hash(raw)
                val existing = dir.snapshot().filterNot { it.machineId == fromId && it.scope == "full" }
                dir.save(existing + PhonePair(hash, name, hash, null, 0, 0, scope = "full", machineId = fromId))
            }
        }
        val id = newRequestId()
        pendingJoins[id] = PendingJoin(secret, token, fromId)
        return jsonResponse(200, JSONObject().put("id", id).put("join", true).put("granted", true).toString())
    }

    fun handleJoinPoll(payload: JSONObject): DavResponse {
        val id = payload.optString("id")
        val secret = payload.optString("secret")
        val row = pendingJoins[id] ?: return jsonResponse(409, """{"error":"That approval request is gone.","missing":true}""")
        if (row.secret != secret) return jsonResponse(409, """{"error":"This machine has not approved that request yet."}""")
        pendingJoins.remove(id)
        return jsonResponse(200, JSONObject().put("token", row.token).put("scope", "full").toString())
    }

    fun attestationOk(attestation: JSONObject, dek: ByteArray, joinerId: String, pairs: PhonePairDirectory?): Boolean {
        val approverId = attestation.optString("approverId")
        val attestedJoiner = attestation.optString("joinerId")
        val requestId = attestation.optString("requestId")
        val hostId = attestation.optString("hostId")
        val issuedAt = attestation.optString("issuedAt")
        val proof = attestation.optString("proof")
        val signature = attestation.optString("signature")
        if (listOf(approverId, attestedJoiner, requestId, hostId, issuedAt, proof, signature).any { it.isBlank() }) return false
        if (attestedJoiner != joinerId) return false
        val trusted = pairs?.snapshot()?.any { it.machineId == approverId && it.scope == "full" } == true ||
            (appContext != null && CredentialVault(appContext!!).load("link-scope-$approverId").orEmpty() == "full")
        if (!trusted) return false
        val expected = MesaJoin.approvalProof(dek, approverId, attestedJoiner, requestId)
        if (expected != proof) return false
        val age = runCatching { java.time.Instant.parse(issuedAt) }.getOrNull()?.let { System.currentTimeMillis() - it.toEpochMilli() } ?: return false
        if (age > 30 * 60 * 1000 || age < -60 * 1000) return false
        return true
    }

    private fun newRequestId(): String {
        val bytes = ByteArray(16).also { SecureRandom().nextBytes(it) }
        return bytes.joinToString("") { "%02x".format(it) }
    }

    fun jsonResponse(status: Int, body: String): DavResponse {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val reason = if (status == 200) "OK" else if (status == 409) "Conflict" else if (status == 400) "Bad Request" else "Forbidden"
        return DavResponse(status, reason, mapOf("Content-Type" to "application/json; charset=utf-8", "Content-Length" to bytes.size.toString()), bytes)
    }

    private fun getJson(url: String, token: String): Pair<Int, String> {
        val connection = URL(url).openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "GET"
            connection.setRequestProperty("Authorization", "Bearer $token")
            connection.setRequestProperty("Accept", "application/json")
            connection.connectTimeout = 4000
            connection.readTimeout = 4000
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            code to (stream?.bufferedReader()?.readText().orEmpty())
        } catch (err: Exception) {
            0 to ""
        } finally {
            connection.disconnect()
        }
    }

    private fun postJson(url: String, body: String, token: String): Pair<Int, String> {
        val connection = URL(url).openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.setRequestProperty("Authorization", "Bearer $token")
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.setRequestProperty("Accept", "application/json")
            connection.connectTimeout = 5000
            connection.readTimeout = 8000
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            code to (stream?.bufferedReader()?.readText().orEmpty())
        } catch (err: Exception) {
            0 to ""
        } finally {
            connection.disconnect()
        }
    }
}
