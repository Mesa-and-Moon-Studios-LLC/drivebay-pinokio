package com.lordstryfe.drivebay

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.time.Instant

/**
 * After a trusted join is approved, this phone issues a token so the computer
 * can browse shared storage too. The offer is signed with the phone's device key
 * and is only sent when this phone already holds a full grant from that computer.
 */
object MesaReciprocal {
    private const val PREFS = "drivebay_mesa"
    private const val NEED_ALL_FILES = "needAllFilesForLink"
    private const val PEERS = "reciprocal-hosts"

    fun trustedPairId(machineId: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest("trusted-join:$machineId".toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    fun offerPayload(privateKeyB64: String, hostId: String, peerId: String, accessToken: String, issuedAt: String): JSONObject {
        val offer = JSONObject()
            .put("hostId", hostId)
            .put("peerId", peerId)
            .put("accessToken", accessToken)
            .put("issuedAt", issuedAt)
        return JSONObject()
            .put("offer", offer)
            .put("signature", MesaJoin.reciprocalSignature(privateKeyB64, hostId, peerId, accessToken, issuedAt))
    }

    fun needsAllFiles(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(NEED_ALL_FILES, false)

    fun rememberNeedAllFiles(context: Context, needed: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(NEED_ALL_FILES, needed).apply()
    }

    fun startShare(context: Context) {
        val missing = !PhoneShareService.allFilesAccess()
        rememberNeedAllFiles(context, missing)
        PhoneShareService.start(context)
    }

    fun looksLikeInbound(token: String): Boolean =
        Regex("^(db_|dbp_)[0-9a-f]{64}$").matches(token)

    fun offerTo(context: Context, host: JSONObject, inboundToken: String): Boolean {
        if (!looksLikeInbound(inboundToken)) return false
        val hostId = host.optString("machineId")
        if (hostId.isBlank()) return false
        rememberPeer(context, host)
        val origin = originOf(host) ?: return false
        val me = machineId(context)
        val privateKey = CredentialVault(context).load("mesa-machine-private").orEmpty()
        if (privateKey.isBlank() || me.isBlank()) return false
        val vault = CredentialVault(context)
        val existing = vault.load("reciprocal-$hostId").orEmpty()
        val accessToken = if (PhoneShareAuth.looksLikeToken(existing)) existing else PhoneShareAuth.generateToken()
        val issuedAt = Instant.now().toString()
        val body = offerPayload(privateKey, hostId, me, accessToken, issuedAt)
        body.put("token", inboundToken)
        val (status, _) = postJson("$origin/api/link/reciprocal", body.toString(), inboundToken)
        if (status !in 200..299) return false
        vault.save("reciprocal-$hostId", accessToken)
        PhoneShareStore(context).upsertTrustedPair(host.optString("displayName"), accessToken, hostId)
        startShare(context)
        return true
    }

    fun offerPending(context: Context, machines: JSONArray) {
        val vault = CredentialVault(context)
        val me = machineId(context)
        val rows = linkedMapOf<String, JSONObject>()
        for (source in listOf(machines, savedPeers(context))) {
            for (i in 0 until source.length()) {
                val row = source.optJSONObject(i) ?: continue
                val id = row.optString("machineId")
                if (id.isNotBlank()) rows[id] = row
            }
        }
        for ((id, row) in rows) {
            if (id == me) continue
            val token = vault.load("link-$id").orEmpty()
            if (token.isBlank()) continue
            if (vault.load("link-scope-$id").orEmpty() != "full") continue
            runCatching { offerTo(context, row, token) }
        }
    }

    fun rememberPeer(context: Context, host: JSONObject) {
        val id = host.optString("machineId")
        val origin = originOf(host) ?: return
        if (id.isBlank()) return
        val stub = JSONObject()
            .put("machineId", id)
            .put("displayName", host.optString("displayName"))
            .put("type", host.optString("type"))
            .put("tailscaleHost", host.optString("tailscaleHost"))
            .put("lanHost", host.optString("lanHost"))
            .put("port", host.optInt("port"))
            .put("origin", origin)
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val arr = runCatching { JSONArray(prefs.getString(PEERS, "[]")) }.getOrElse { JSONArray() }
        val next = JSONArray()
        var replaced = false
        for (i in 0 until arr.length()) {
            val row = arr.optJSONObject(i) ?: continue
            if (row.optString("machineId") == id) {
                next.put(stub)
                replaced = true
            } else {
                next.put(row)
            }
        }
        if (!replaced) next.put(stub)
        prefs.edit().putString(PEERS, next.toString()).apply()
    }

    private fun savedPeers(context: Context): JSONArray {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(PEERS, "[]")
        return runCatching { JSONArray(raw) }.getOrElse { JSONArray() }
    }

    fun forgetPeer(context: Context, machine: JSONObject) {
        val hostId = machine.optString("machineId")
        val vault = CredentialVault(context)
        val inbound = vault.load("link-$hostId").orEmpty()
        val origin = originOf(machine)
        val me = machineId(context)
        val privateKey = vault.load("mesa-machine-private").orEmpty()
        val issuedAt = Instant.now().toString()
        if (origin != null && me.isNotBlank() && privateKey.isNotBlank()) {
            val body = JSONObject()
                .put("fromId", me)
                .put("peerId", hostId)
                .put("issuedAt", issuedAt)
                .put("signature", MesaJoin.forgetSignature(privateKey, me, hostId, issuedAt))
            if (inbound.isNotBlank()) body.put("token", inbound)
            runCatching { postJson("$origin/api/link/forget", body.toString(), inbound) }
        }
        forgetLocal(context, hostId)
    }

    fun forgetLocal(context: Context, machineId: String) {
        if (machineId.isBlank()) return
        val vault = CredentialVault(context)
        runCatching {
            vault.forget("link-$machineId")
            vault.forget("link-scope-$machineId")
            vault.forget("reciprocal-$machineId")
        }
        PhoneShareStore(context).revokeByMachineId(machineId)
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val arr = runCatching { JSONArray(prefs.getString(PEERS, "[]")) }.getOrElse { JSONArray() }
        val next = JSONArray()
        for (i in 0 until arr.length()) {
            val row = arr.optJSONObject(i) ?: continue
            if (row.optString("machineId") != machineId) next.put(row)
        }
        prefs.edit().putString(PEERS, next.toString()).apply()
    }

    private fun originOf(machine: JSONObject): String? {
        val saved = machine.optString("origin")
        if (saved.startsWith("http://") || saved.startsWith("https://")) return saved.trimEnd('/')
        val url = MesaCloud.connectionUrl(machine)
        if (url.isEmpty()) return null
        return url.substringBefore("/dav").trimEnd('/').ifBlank { null }
    }

    private fun machineId(context: Context): String =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("machineId", "").orEmpty()

    private fun postJson(url: String, body: String, bearer: String): Pair<Int, String> {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            if (bearer.isNotBlank()) setRequestProperty("Authorization", "Bearer $bearer")
            connectTimeout = 8000
            readTimeout = 8000
        }
        return try {
            connection.outputStream.use { it.write(body.toByteArray()) }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            code to (stream?.bufferedReader()?.readText() ?: "")
        } catch (_: Exception) {
            0 to ""
        } finally {
            connection.disconnect()
        }
    }
}
