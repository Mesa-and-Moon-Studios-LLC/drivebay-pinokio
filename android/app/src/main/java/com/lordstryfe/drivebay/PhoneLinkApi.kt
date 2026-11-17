package com.lordstryfe.drivebay

import org.json.JSONObject

/**
 * Small JSON API on the phone share port. Used so a trusted computer can end a
 * two-way grant without going through the Mesa and Moon servers.
 */
object PhoneLinkApi {
    fun handle(
        method: String,
        path: String,
        headers: Map<String, String>,
        body: ByteArray,
        remote: String?,
        pairs: PhonePairDirectory?,
        onForget: (String) -> Unit,
    ): DavResponse? {
        val pathname = path.substringBefore('?')
        if (pathname == "/api/link/honor-approval" && method == "POST") {
            if (!PhoneShareNet.isPrivateOrTailscale(remote)) {
                return json(403, """{"error":"Pairing is only accepted from Tailscale, LAN, or this machine."}""")
            }
            val payload = runCatching { JSONObject(body.toString(Charsets.UTF_8).ifBlank { "{}" }) }.getOrNull() ?: JSONObject()
            val attestation = payload.optJSONObject("attestation") ?: payload
            val error = MesaSponsor.honorInbound(attestation)
            return if (error == null) json(200, """{"ok":true}""") else json(403, JSONObject().put("error", error).toString())
        }
        if (pathname == "/api/link/request" && method == "POST") {
            if (!PhoneShareNet.isPrivateOrTailscale(remote)) {
                return json(403, """{"error":"Pairing is only accepted from Tailscale, LAN, or this machine."}""")
            }
            val payload = runCatching { JSONObject(body.toString(Charsets.UTF_8).ifBlank { "{}" }) }.getOrNull()
                ?: return json(400, """{"error":"The request secret is missing."}""")
            return MesaSponsor.handleJoinRequest(payload, pairs)
        }
        if (pathname == "/api/link/poll" && method == "POST") {
            if (!PhoneShareNet.isPrivateOrTailscale(remote)) {
                return json(403, """{"error":"Pairing is only accepted from Tailscale, LAN, or this machine."}""")
            }
            val payload = runCatching { JSONObject(body.toString(Charsets.UTF_8).ifBlank { "{}" }) }.getOrNull()
                ?: return json(409, """{"error":"That approval request is gone.","missing":true}""")
            return MesaSponsor.handleJoinPoll(payload)
        }
        if (pathname == "/api/link/reciprocal" && method == "POST") {
            if (!PhoneShareNet.isPrivateOrTailscale(remote)) {
                return json(403, """{"error":"Pairing is only accepted from Tailscale, LAN, or this machine."}""")
            }
            if (pairs == null) return json(403, """{"error":"Only a machine this phone already trusts can offer a reciprocal grant."}""")
            val inbound = bearerOrBasic(headers)
            val payload = runCatching { JSONObject(body.toString(Charsets.UTF_8).ifBlank { "{}" }) }.getOrNull() ?: JSONObject()
            val token = inbound.ifBlank { payload.optString("token") }
            val hit = pairs.snapshot().firstOrNull { token.isNotBlank() && PhoneShareAuth.looksLikeToken(token) && PhoneShareAuth.matches(token, it.tokenHash) }
            if (hit == null || hit.scope != "full") return json(403, """{"error":"Only a machine this phone already trusts can offer a reciprocal grant."}""")
            val offer = payload.optJSONObject("offer") ?: payload
            val accessToken = offer.optString("accessToken")
            val peerId = offer.optString("peerId")
            if (!PhoneShareAuth.looksLikeToken(accessToken) || peerId.isBlank()) {
                return json(403, """{"error":"The access token is not valid."}""")
            }
            MesaSponsor.appContext?.let { ctx ->
                val vault = CredentialVault(ctx)
                vault.save("link-$peerId", accessToken)
                vault.save("link-scope-$peerId", "full")
            }
            return json(200, """{"ok":true,"scope":"full"}""")
        }
        if (pathname != "/api/link/forget" || method != "POST") return null
        if (!PhoneShareNet.isPrivateOrTailscale(remote)) {
            return json(403, """{"error":"Pairing is only accepted from Tailscale, LAN, or this machine."}""")
        }
        if (pairs == null) return json(403, """{"error":"That machine is not paired."}""")
        val token = bearerOrBasic(headers)
        val payload = runCatching { JSONObject(body.toString(Charsets.UTF_8).ifBlank { "{}" }) }.getOrNull() ?: JSONObject()
        val inbound = token.ifBlank { payload.optString("token") }
        val snapshot = pairs.snapshot()
        val hit = snapshot.firstOrNull { inbound.isNotBlank() && PhoneShareAuth.looksLikeToken(inbound) && PhoneShareAuth.matches(inbound, it.tokenHash) }
        if (hit == null) return json(403, """{"error":"That machine is not paired."}""")
        pairs.save(PhonePairRules.revoke(snapshot, hit.id))
        val machineId = hit.machineId
        if (machineId.isNotBlank()) runCatching { onForget(machineId) }
        return json(200, """{"ok":true}""")
    }

    private fun bearerOrBasic(headers: Map<String, String>): String {
        val auth = headers.entries.firstOrNull { it.key.equals("authorization", true) }?.value.orEmpty()
        val bearer = Regex("^Bearer\\s+(\\S+)$", RegexOption.IGNORE_CASE).find(auth.trim())
        if (bearer != null) return bearer.groupValues[1]
        val parsed = PhoneShareAuth.parseBasic(auth) ?: return ""
        return parsed.second
    }

    private fun json(status: Int, body: String): DavResponse {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val reason = when (status) {
            200 -> "OK"
            403 -> "Forbidden"
            else -> "Error"
        }
        return DavResponse(status, reason, mapOf("Content-Type" to "application/json; charset=utf-8", "Content-Length" to bytes.size.toString()), bytes)
    }
}
