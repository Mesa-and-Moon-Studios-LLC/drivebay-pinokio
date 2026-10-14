package com.lordstryfe.drivebay

import java.net.URI
import java.net.URLDecoder

/**
 * Drivebay addresses. 8765 is the suggested port. 8766 is common on installs
 * that already had 8765 taken. 42000-42999 is the old Pinokio Caddy range.
 */
object ServerAddress {
    const val SUGGESTED_PORT = 8765
    const val ALSO_COMMON_PORT = 8766
    const val LEGACY_MIN = 42000
    const val LEGACY_MAX = 42999

    fun normalize(raw: String): String {
        var u = raw.trim()
        if (u.isEmpty()) return u
        if (!u.startsWith("http://") && !u.startsWith("https://")) {
            u = "http://$u"
        }
        while (u.endsWith("/") && u.count { it == '/' } > 2) {
            u = u.dropLast(1)
        }
        return u
    }

    fun portOf(raw: String): Int? {
        val uri = parse(raw) ?: return null
        return if (uri.port != -1) uri.port else null
    }

    fun hostOf(raw: String): String? = parse(raw)?.host

    fun isLegacyPort(port: Int): Boolean = port in LEGACY_MIN..LEGACY_MAX

    fun withPort(raw: String, port: Int): String {
        val uri = parse(raw) ?: return normalize(raw)
        val host = uri.host ?: return normalize(raw)
        return origin(uri, host, port) + "/"
    }

    /** Server settings live on the PC. The app must not open that page. */
    fun isAdminSettingsPath(path: String?): Boolean {
        if (path.isNullOrBlank()) return false
        val clean = path.substringBefore('?').let { if (it.length > 1 && it.endsWith("/")) it.dropLast(1) else it }
        return clean == "/settings" || clean.startsWith("/settings/")
    }

    fun isAdminSettingsUrl(raw: String): Boolean {
        val uri = parse(raw) ?: return false
        return isAdminSettingsPath(uri.rawPath ?: uri.path)
    }

    /** File browser home. Drops a saved folder, settings path, or query. */
    fun homeUrl(raw: String): String {
        val uri = parse(raw) ?: return normalize(raw).let { if (it.endsWith("/")) it else "$it/" }
        val host = uri.host ?: return normalize(raw).let { if (it.endsWith("/")) it else "$it/" }
        val port = if (uri.port != -1) uri.port else null
        return origin(uri, host, port) + "/"
    }

    private fun parse(raw: String): URI? {
        return try {
            URI(normalize(raw))
        } catch (_: Exception) {
            null
        }
    }

    private fun origin(uri: URI, host: String, port: Int?): String {
        val scheme = uri.scheme ?: "http"
        val user = if (uri.userInfo != null) "${uri.userInfo}@" else ""
        val bracketed = if (host.contains(":") && !host.startsWith("[")) "[$host]" else host
        val portPart = if (port != null && port > 0) ":$port" else ""
        return "$scheme://$user$bracketed$portPart"
    }
}

object DownloadNames {
    fun safeFileName(name: String): String {
        val cleaned = name
            .replace(Regex("""[\\/:*?"<>|\u0000]"""), "_")
            .trim { it.isWhitespace() || it == '.' || it == '_' }
        val cut = cleaned.take(120)
        return cut.ifBlank { "download" }
    }

    fun fileNameFromDownloadUrl(url: String, suggested: String?): String {
        val hint = suggested?.trim().orEmpty()
        if (hint.isNotEmpty() && !hint.equals("unknown", ignoreCase = true)) {
            return safeFileName(hint)
        }
        val uri = try {
            URI(url)
        } catch (_: Exception) {
            return "download"
        }
        val query = uri.rawQuery.orEmpty()
        val pathParam = query.split("&")
            .map { it.split("=", limit = 2) }
            .firstOrNull { it[0] == "path" }
            ?.getOrNull(1)
        if (!pathParam.isNullOrEmpty()) {
            val decoded = try {
                URLDecoder.decode(pathParam, "UTF-8")
            } catch (_: Exception) {
                pathParam
            }
            val base = decoded.substringAfterLast('\\').substringAfterLast('/')
            if (base.isNotBlank()) return safeFileName(base)
        }
        val last = uri.path.orEmpty().substringAfterLast('/')
        if (last.isNotBlank()) return safeFileName(last)
        return "download"
    }
}
