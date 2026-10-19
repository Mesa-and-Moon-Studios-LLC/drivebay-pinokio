package com.lordstryfe.drivebay

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * Phone-as-drive auth uses the same token shape as Drivebay API tokens:
 * db_ plus 64 hex characters. The phone stores only the SHA-256 hash.
 * WebDAV clients send it as the HTTP Basic password. The username is "drivebay".
 */
object PhoneShareAuth {
    const val USER = "drivebay"
    private val TOKEN = Regex("^db_[0-9a-f]{64}$")

    fun generateToken(random: SecureRandom = SecureRandom()): String {
        val bytes = ByteArray(32)
        random.nextBytes(bytes)
        return "db_" + bytes.joinToString("") { "%02x".format(it) }
    }

    fun looksLikeToken(token: String): Boolean = TOKEN.matches(token)

    fun hash(token: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    fun matches(password: String, hashHex: String): Boolean {
        if (!looksLikeToken(password) || hashHex.length != 64) return false
        val got = hash(password)
        if (got.length != hashHex.length) return false
        var diff = 0
        for (i in got.indices) diff = diff or (got[i].code xor hashHex[i].code)
        return diff == 0
    }

    fun basicHeader(user: String, secret: String): String {
        val raw = "$user:$secret".toByteArray(Charsets.UTF_8)
        return "Basic " + Base64.getEncoder().encodeToString(raw)
    }

    fun parseBasic(header: String?): Pair<String, String>? {
        if (header.isNullOrBlank()) return null
        val trimmed = header.trim()
        if (!trimmed.startsWith("Basic ", ignoreCase = true)) return null
        val decoded = try {
            String(Base64.getDecoder().decode(trimmed.substring(6).trim()), Charsets.UTF_8)
        } catch (_: Exception) {
            return null
        }
        val colon = decoded.indexOf(':')
        if (colon <= 0) return null
        return decoded.substring(0, colon) to decoded.substring(colon + 1)
    }

    fun authorized(header: String?, hashHex: String): Boolean {
        val parsed = parseBasic(header) ?: return false
        if (!parsed.first.equals(USER, ignoreCase = true)) return false
        return matches(parsed.second, hashHex)
    }
}

/** LAN and Tailscale only. A public address is not a place to share the phone. */
object PhoneShareNet {
    fun isPrivateOrTailscale(host: String?): Boolean {
        if (host.isNullOrBlank()) return false
        var value = host.trim().lowercase().removePrefix("[").substringBefore("]")
        val zone = value.indexOf('%')
        if (zone >= 0) value = value.substring(0, zone)
        if (value.startsWith("::ffff:")) value = value.removePrefix("::ffff:")
        if (value.contains(":")) return isTailscaleIpv6(value) || isLinkLocalIpv6(value) || isUniqueLocal(value)
        val parts = value.split(".")
        if (parts.size != 4) return false
        val nums = parts.map { it.toIntOrNull() ?: return false }
        if (nums.any { it !in 0..255 }) return false
        val a = nums[0]
        val b = nums[1]
        if (a == 10) return true
        if (a == 127) return true
        if (a == 192 && b == 168) return true
        if (a == 172 && b in 16..31) return true
        if (a == 169 && b == 254) return true
        // Tailscale IPv4 100.64.0.0/10
        if (a == 100 && b in 64..127) return true
        return false
    }

    private fun isTailscaleIpv6(host: String): Boolean = host.startsWith("fd7a:115c:a1e0:")

    private fun isLinkLocalIpv6(host: String): Boolean = host.startsWith("fe80:")

    private fun isUniqueLocal(host: String): Boolean {
        if (!host.startsWith("fd") && !host.startsWith("fc")) return false
        return host.getOrNull(2)?.isDigit() == true || host.getOrNull(2) in 'a'..'f'
    }
}
