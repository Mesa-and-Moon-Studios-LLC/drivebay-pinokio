package com.lordstryfe.drivebay

import org.json.JSONObject
import java.net.URLEncoder
import java.util.Locale

/**
 * Mesa and Moon account helpers that do not need Android.
 * The cloud body is connection info only.
 */
object MesaCloud {
    val cloudKeys = listOf(
        "machineId",
        "displayName",
        "type",
        "tailscaleHost",
        "lanAddress",
        "port",
        "publicKey",
        "lastSeen",
        "hidden",
        "directInternet",
        "publicHost",
    )

    data class Config(
        val apiKey: String,
        val authDomain: String,
        val projectId: String,
        val googleClientId: String,
        val appleClientId: String,
        val cloudApi: String,
    ) {
        val ready: Boolean
            get() = apiKey.isNotBlank() && projectId.isNotBlank() && cloudApi.isNotBlank() &&
                (googleClientId.isNotBlank() || appleClientId.isNotBlank())
    }

    fun parseConfig(text: String): Config? {
        return try {
            val json = JSONObject(text)
            Config(
                apiKey = json.optString("apiKey").trim(),
                authDomain = json.optString("authDomain").trim(),
                projectId = json.optString("projectId").trim(),
                googleClientId = json.optString("googleClientId").trim(),
                appleClientId = json.optString("appleClientId").trim(),
                cloudApi = json.optString("cloudApi").trim().trimEnd('/'),
            )
        } catch (_: Exception) {
            null
        }
    }

    fun registration(
        machineId: String,
        displayName: String,
        tailscaleHost: String,
        lanAddress: String,
        port: Int,
        publicKey: String,
        lastSeen: String,
        hidden: Boolean,
        directInternet: Boolean,
        publicHost: String,
    ): JSONObject {
        val body = JSONObject()
        body.put("machineId", machineId)
        body.put("displayName", displayName)
        body.put("type", "phone")
        body.put("tailscaleHost", tailscaleHost)
        body.put("lanAddress", lanAddress)
        body.put("port", port)
        body.put("publicKey", publicKey)
        body.put("lastSeen", lastSeen)
        body.put("hidden", hidden)
        body.put("directInternet", directInternet)
        body.put("publicHost", if (directInternet) publicHost else "")
        return body
    }

    fun classify(addresses: List<String>): Pair<String, String> {
        var tailscale = ""
        var lan = ""
        for (raw in addresses) {
            val host = raw.trim().substringBefore('%')
            if (tailscale.isEmpty() && isTailscale(host)) tailscale = host
            else if (lan.isEmpty() && isLan(host)) lan = host
        }
        return tailscale to lan
    }

    fun connectionUrl(machine: JSONObject): String {
        val port = machine.optInt("port")
        val type = machine.optString("type")
        val path = if (type == "phone") "/" else "/dav/"
        val host = when {
            machine.optString("tailscaleHost").isNotBlank() -> machine.optString("tailscaleHost")
            machine.optString("lanAddress").isNotBlank() -> machine.optString("lanAddress")
            machine.optBoolean("directInternet") && machine.optString("publicHost").isNotBlank() -> machine.optString("publicHost")
            else -> ""
        }
        if (host.isEmpty() || port <= 0) return ""
        val literal = if (host.contains(":") && !host.startsWith("[")) "[$host]" else host
        return "http://$literal:$port$path"
    }

    fun usesPublicInternet(machine: JSONObject): Boolean {
        return machine.optString("tailscaleHost").isBlank() &&
            machine.optString("lanAddress").isBlank() &&
            machine.optBoolean("directInternet") &&
            machine.optString("publicHost").isNotBlank()
    }

    fun isOnline(lastSeen: String, nowMs: Long): Boolean {
        val seen = runCatching { java.time.Instant.parse(lastSeen).toEpochMilli() }.getOrDefault(-1L)
        if (seen < 0) return false
        val delta = nowMs - seen
        return delta >= -5_000 && delta <= 120_000
    }

    fun googleAuthorizeUrl(clientId: String, redirectUri: String, nonce: String): String {
        return "https://accounts.google.com/o/oauth2/v2/auth?client_id=" + enc(clientId) +
            "&redirect_uri=" + enc(redirectUri) +
            "&response_type=id_token&scope=" + enc("openid email profile") +
            "&nonce=" + enc(nonce) +
            "&state=" + enc("google.$nonce") +
            "&prompt=select_account"
    }

    fun appleAuthorizeUrl(clientId: String, redirectUri: String, nonce: String): String {
        return "https://appleid.apple.com/auth/authorize?client_id=" + enc(clientId) +
            "&redirect_uri=" + enc(redirectUri) +
            "&response_type=id_token&response_mode=fragment&scope=" + enc("name email") +
            "&nonce=" + enc(nonce) +
            "&state=" + enc("apple.$nonce")
    }

    fun readFragment(uri: String): Triple<String, String, String>? {
        val fragment = uri.substringAfter('#', "")
        if (fragment.isEmpty()) return null
        val params = fragment.split('&').mapNotNull { part ->
            val cut = part.indexOf('=')
            if (cut <= 0) null else part.substring(0, cut) to java.net.URLDecoder.decode(part.substring(cut + 1), "UTF-8")
        }.toMap()
        val token = params["id_token"] ?: return null
        val state = params["state"] ?: return null
        val provider = state.substringBefore('.')
        val nonce = state.substringAfter('.', "")
        if (provider != "google" && provider != "apple") return null
        return Triple(provider, nonce, token)
    }

    fun shareNames(xml: String): List<String> {
        val names = Regex("<d:displayname>([^<]*)</d:displayname>").findAll(xml).map { it.groupValues[1] }.toList()
        return if (names.size <= 1) emptyList() else names.drop(1)
    }

    fun idpBody(providerId: String, idToken: String, requestUri: String): String {
        return JSONObject()
            .put("postBody", "id_token=" + enc(idToken) + "&providerId=" + providerId)
            .put("requestUri", requestUri)
            .put("returnSecureToken", true)
            .put("returnIdpCredential", true)
            .toString()
    }

    private fun enc(value: String): String = URLEncoder.encode(value, "UTF-8")

    private fun isTailscale(host: String): Boolean {
        val lower = host.lowercase(Locale.US)
        if (lower.startsWith("fd7a:115c:a1e0:")) return true
        val parts = lower.split('.')
        if (parts.size != 4) return false
        val nums = parts.map { it.toIntOrNull() ?: return false }
        return nums[0] == 100 && nums[1] in 64..127
    }

    private fun isLan(host: String): Boolean {
        if (isTailscale(host)) return false
        val parts = host.split('.')
        if (parts.size != 4) return false
        val nums = parts.map { it.toIntOrNull() ?: return false }
        val a = nums[0]
        val b = nums[1]
        if (a == 10 || (a == 192 && b == 168)) return true
        return a == 172 && b in 16..31
    }
}
