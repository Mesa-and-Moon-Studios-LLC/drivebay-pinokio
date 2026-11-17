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
