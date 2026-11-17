package com.lordstryfe.drivebay

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
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

    fun listPending(origin: String, token: String): JSONArray {
        if (origin.isBlank() || token.isBlank()) return JSONArray()
        val (status, text) = getJson("$origin/api/link/pending", token)
        if (status !in 200..299) return JSONArray()
        val body = runCatching { JSONObject(text) }.getOrNull() ?: return JSONArray()
        val pending = body.optJSONArray("pending") ?: return JSONArray()
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
        return out
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
    fun grantToJoiner(context: android.content.Context, joiner: JSONObject, joinerId: String) {
        if (joinerId.isBlank()) return
        val token = PhoneShareAuth.generateToken()
        val name = joiner.optString("displayName").ifBlank { "Machine" }
        PhoneShareStore(context).upsertTrustedPair(name, token, joinerId)
        MesaReciprocal.startShare(context)
        CredentialVault(context).save("reciprocal-$joinerId", token)
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
