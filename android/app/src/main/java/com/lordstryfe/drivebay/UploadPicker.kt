package com.lordstryfe.drivebay

import java.io.File
import java.net.URLEncoder

/** File-chooser accept lists and the raw upload URL the app posts picked files to. */
object UploadPicker {
    fun mimeTypes(accept: Array<String>?): List<String> {
        if (accept == null || accept.isEmpty()) return listOf("*/*")
        val cleaned = accept.map { it.trim() }.filter { it.isNotEmpty() && it != "*/*" && it != "*" }
        return cleaned.ifEmpty { listOf("*/*") }
    }

    fun cacheName(displayName: String?, index: Int): String {
        val base = DownloadNames.safeFileName(displayName?.substringAfterLast('/')?.substringAfterLast('\\') ?: "")
        return "${index}-${base}"
    }

    fun rawUploadUrl(pageUrl: String, parent: String, name: String): String? {
        val origin = originOf(pageUrl) ?: return null
        if (parent.isBlank() || name.isBlank()) return null
        if (name.contains('/') || name.contains('\\') || name.contains('\u0000')) return null
        val parentQ = URLEncoder.encode(parent, "UTF-8")
        val nameQ = URLEncoder.encode(name, "UTF-8")
        return "$origin/api/upload?parent=$parentQ&name=$nameQ"
    }

    fun originOf(pageUrl: String): String? {
        val normalized = ServerAddress.normalize(pageUrl)
        val slash = normalized.indexOf("://")
        if (slash < 0) return null
        val rest = normalized.substring(slash + 3)
        val hostPort = rest.substringBefore('/').substringBefore('?')
        if (hostPort.isBlank()) return null
        return normalized.substring(0, slash + 3) + hostPort
    }

    fun uploadFile(cacheDir: File, displayName: String?, index: Int): File {
        val dir = File(cacheDir, "uploads").apply { mkdirs() }
        return File(dir, cacheName(displayName, index))
    }
}
