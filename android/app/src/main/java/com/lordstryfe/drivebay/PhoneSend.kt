package com.lordstryfe.drivebay

import org.json.JSONArray
import java.net.URLConnection
import java.util.Locale

/**
 * "Send to" from the file browser: the page hands over download links,
 * the app fetches them into cache/share and opens the Android share sheet.
 */
object PhoneSend {
    const val MAX_FILES = 50
    const val MAX_TOTAL_BYTES = 1024L * 1024L * 1024L

    data class Item(val url: String, val name: String, val size: Long)

    fun parse(json: String): List<Item> {
        val array = runCatching { JSONArray(json) }.getOrNull() ?: return emptyList()
        val out = mutableListOf<Item>()
        for (i in 0 until minOf(array.length(), MAX_FILES)) {
            val row = array.optJSONObject(i) ?: continue
            val url = row.optString("url").trim()
            val lower = url.lowercase(Locale.US)
            if (!lower.startsWith("http://") && !lower.startsWith("https://")) continue
            out.add(Item(url, safeName(row.optString("name"), i), row.optLong("size", 0L).coerceAtLeast(0L)))
        }
        return out
    }

    /** A file name that cannot leave the share folder. */
    fun safeName(raw: String, index: Int): String {
        val base = raw.substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[\\u0000-\\u001f:*?\"<>|]"), "_")
            .trim().trim('.')
        val name = if (base.isEmpty()) "file-${index + 1}" else base
        return if (name.length > 120) name.takeLast(120) else name
    }

    /** Unique names inside one share batch. */
    fun dedupe(names: List<String>): List<String> {
        val seen = HashSet<String>()
        return names.map { name ->
            var candidate = name
            var n = 2
            while (!seen.add(candidate.lowercase(Locale.US))) {
                val dot = name.lastIndexOf('.')
                candidate = if (dot > 0) "${name.substring(0, dot)} ($n)${name.substring(dot)}" else "$name ($n)"
                n += 1
            }
            candidate
        }
    }

    fun mimeOf(name: String): String = URLConnection.guessContentTypeFromName(name) ?: "application/octet-stream"

    // One shared type for ACTION_SEND_MULTIPLE: the exact type, the same family with a wildcard, or anything.
    fun commonMime(types: List<String>): String {
        if (types.isEmpty()) return "*/*"
        if (types.distinct().size == 1) return types.first()
        val heads = types.map { it.substringBefore('/') }.distinct()
        return if (heads.size == 1) "${heads.first()}/*" else "*/*"
    }
}
