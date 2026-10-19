package com.lordstryfe.drivebay

import java.net.URI

/**
 * Saved Drivebay PCs. 3.33.0 kept one address. 3.33.4 (the Play build) keeps a list.
 * The key ignores a trailing slash and the path so the same PC is not saved twice.
 */
data class SavedServer(
    val id: String,
    val name: String,
    val url: String,
    val username: String? = null,
    val rememberLogin: Boolean = true,
)

object ServerProfiles {
    fun keyOf(raw: String): String {
        val normalized = ServerAddress.normalize(raw).trim()
        val uri = try {
            URI(normalized)
        } catch (_: Exception) {
            return normalized.lowercase()
        }
        val host = uri.host?.lowercase() ?: return normalized.lowercase()
        val port = if (uri.port != -1) uri.port else if (uri.scheme.equals("https", true)) 443 else 80
        val scheme = (uri.scheme ?: "http").lowercase()
        return "$scheme://$host:$port"
    }

    fun isLoginUrl(raw: String): Boolean {
        val uri = try {
            URI(ServerAddress.normalize(raw))
        } catch (_: Exception) {
            return false
        }
        val path = (uri.rawPath ?: uri.path ?: "").substringBefore('?')
        val clean = if (path.length > 1 && path.endsWith("/")) path.dropLast(1) else path
        return clean == "/login" || clean.startsWith("/login/")
    }

    fun defaultName(raw: String): String {
        val uri = try {
            URI(ServerAddress.normalize(raw))
        } catch (_: Exception) {
            return "Drivebay"
        }
        val host = uri.host?.trim().orEmpty()
        return host.ifBlank { "Drivebay" }.take(40)
    }

    /** A JS string literal, safe to embed in the login fill script. */
    fun jsString(value: String): String {
        val escaped = buildString(value.length + 2) {
            append('"')
            for (ch in value) {
                when (ch) {
                    '\\' -> append("\\\\")
                    '"' -> append("\\\"")
                    '\n' -> append("\\n")
                    '\r' -> append("\\r")
                    '\u2028' -> append("\\u2028")
                    '\u2029' -> append("\\u2029")
                    '<' -> append("\\u003c")
                    else -> append(ch)
                }
            }
            append('"')
        }
        return escaped
    }

    fun idFor(url: String): String = keyOf(url).replace(Regex("[^a-z0-9]+"), "-").trim('-').take(80).ifBlank { "server" }
}
