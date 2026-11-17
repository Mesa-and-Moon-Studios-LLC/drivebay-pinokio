package com.lordstryfe.drivebay

import java.io.ByteArrayInputStream
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element

/**
 * Pure logic for the linked-machine file browser: PROPFIND parsing, paths, breadcrumbs, labels.
 * Nothing here touches Android, so it runs in plain JVM tests.
 *
 * A browser path is the folder path on the host's DAV root, decoded, starting with "/".
 * Folders end with "/". The root "/" lists the drives.
 */
object DavBrowse {
    data class Entry(
        val name: String,
        val path: String,
        val isDir: Boolean,
        val size: Long,
        val modifiedMs: Long?,
    )

    data class Crumb(val label: String, val path: String)

    const val ROOT = "/"

    // ---- URL and path helpers ----

    /** "http://host:8765/dav/" gives "/dav". A bare "/" gives "". */
    fun basePath(url: String): String {
        val raw = runCatching { URI(url).rawPath }.getOrNull().orEmpty()
        return decode(raw).trimEnd('/')
    }

    fun origin(url: String): String {
        val uri = runCatching { URI(url) }.getOrNull() ?: return ""
        val host = uri.host ?: return ""
        val literal = if (host.contains(":") && !host.startsWith("[")) "[$host]" else host
        val port = if (uri.port > 0) ":${uri.port}" else ""
        return "${uri.scheme}://$literal$port"
    }

    /** Full request URL for a browser path. Each segment is percent-encoded. */
    fun urlFor(baseUrl: String, path: String): String {
        val base = basePath(baseUrl).split("/").filter { it.isNotEmpty() }.joinToString("") { "/" + encodeSegment(it) }
        return origin(baseUrl) + base + encodePath(path)
    }

    fun encodeSegment(segment: String): String =
        URLEncoder.encode(segment, "UTF-8").replace("+", "%20").replace("*", "%2A").replace("%7E", "~")

    fun encodePath(path: String): String {
        val clean = normalize(path)
        if (clean == ROOT) return "/"
        val body = clean.trim('/').split("/").joinToString("/") { encodeSegment(it) }
        return "/" + body + if (clean.endsWith("/")) "/" else ""
    }

    fun decode(text: String): String =
        runCatching { URLDecoder.decode(text.replace("+", "%2B"), "UTF-8") }.getOrDefault(text)

    fun basicAuth(token: String): String =
        java.util.Base64.getEncoder().encodeToString("drivebay:$token".toByteArray(Charsets.UTF_8))

    /** Leading slash, no doubled slashes, no "." or ".." segments. Keeps a trailing slash. */
    fun normalize(path: String): String {
        val parts = path.split("/").filter { it.isNotEmpty() && it != "." && it != ".." }
        if (parts.isEmpty()) return ROOT
        return "/" + parts.joinToString("/") + if (path.endsWith("/")) "/" else ""
    }

    fun segments(path: String): List<String> = normalize(path).trim('/').split("/").filter { it.isNotEmpty() }

    fun isRoot(path: String): Boolean = segments(path).isEmpty()

    /** The folder one level up, or null at the root. */
    fun parent(path: String): String? {
        val parts = segments(path)
        if (parts.isEmpty()) return null
        if (parts.size == 1) return ROOT
        return "/" + parts.dropLast(1).joinToString("/") + "/"
    }

    /** The drive this path is on: the first segment. Null at the root. */
    fun driveOf(path: String): String? = segments(path).firstOrNull()

    fun child(folder: String, name: String, isDir: Boolean): String {
        val base = normalize(folder).trimEnd('/')
        return "$base/$name" + if (isDir) "/" else ""
    }

    fun folderPath(path: String): String = normalize(path).let { if (it.endsWith("/")) it else "$it/" }

    fun nameOf(path: String): String = segments(path).lastOrNull().orEmpty()

    /** Breadcrumbs from the machine name down to the current folder. */
    fun breadcrumbs(path: String, rootLabel: String): List<Crumb> {
        val crumbs = mutableListOf(Crumb(rootLabel, ROOT))
        var acc = ROOT
        for (part in segments(path)) {
            acc = child(acc, part, true)
            crumbs.add(Crumb(part, acc))
        }
        return crumbs
    }

    /** A name that is safe to create or rename to. Returns an error message, or null when fine. */
    fun nameProblem(name: String): String? {
        val text = name.trim()
        if (text.isEmpty()) return "Type a name."
        if (text == "." || text == "..") return "That name is not allowed."
        if (text.contains('/') || text.contains('\\') || text.contains('\u0000')) return "A name cannot contain / or \\."
        if (text.length > 200) return "That name is too long."
        return null
    }

    /** "report.pdf" taken: "report (1).pdf". */
    fun uniqueName(name: String, taken: Set<String>): String {
        if (name !in taken) return name
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        var i = 1
        while ("$stem ($i)$ext" in taken && i < 10000) i++
        return "$stem ($i)$ext"
    }

    // ---- PROPFIND parsing ----

    /**
     * Entries of a Depth: 1 reply for [requestPath]. The folder itself is left out.
     * [basePath] is the DAV prefix on the host ("/dav", or "" for a phone). Malformed XML gives null.
     */
    fun parseMultistatus(xml: String, requestPath: String, basePath: String): List<Entry>? {
        if (xml.contains("<!DOCTYPE", ignoreCase = true) || xml.contains("<!ENTITY", ignoreCase = true)) return null
        val doc = runCatching {
            val factory = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
            factory.newDocumentBuilder().parse(ByteArrayInputStream(xml.toByteArray(Charsets.UTF_8)))
        }.getOrNull() ?: return null
        val self = normalize(requestPath).trimEnd('/')
        val out = mutableListOf<Entry>()
        val responses = doc.getElementsByTagNameNS("*", "response")
        for (i in 0 until responses.length) {
            val response = responses.item(i) as? Element ?: continue
            val href = text(response, "href") ?: continue
            val path = hrefToPath(href, basePath) ?: continue
            if (path.trimEnd('/') == self) continue
            val isDir = response.getElementsByTagNameNS("*", "collection").length > 0 || href.endsWith("/")
            val size = text(response, "getcontentlength")?.trim()?.toLongOrNull() ?: 0L
            val modified = text(response, "getlastmodified")?.let(::parseHttpDate)
            val name = nameOf(path)
            if (name.isEmpty()) continue
            out.add(Entry(name, if (isDir) folderPath(path) else path.trimEnd('/'), isDir, if (isDir) 0L else size, modified))
        }
        return out
    }

    private fun text(parent: Element, local: String): String? {
        val nodes = parent.getElementsByTagNameNS("*", local)
        if (nodes.length == 0) return null
        return nodes.item(0).textContent
    }

    /** An href is a path or a full URL. Returns the browser path under [basePath], or null if outside it. */
    fun hrefToPath(href: String, basePath: String): String? {
        val raw = href.trim()
        val pathPart = if (raw.contains("://")) {
            runCatching { URI(raw).rawPath }.getOrNull() ?: return null
        } else {
            raw.substringBefore('?')
        }
        val decoded = decode(pathPart)
        val base = basePath.trimEnd('/')
        val rel = when {
            base.isEmpty() -> decoded
            decoded == base -> "/"
            decoded.startsWith("$base/") -> decoded.substring(base.length)
            else -> return null
        }
        return normalize(rel)
    }

    fun parseHttpDate(value: String): Long? = runCatching {
        SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US).apply { timeZone = TimeZone.getTimeZone("GMT") }
            .parse(value.trim())?.time
    }.getOrNull()

    /** Folders first, then files, each A to Z ignoring case. */
    fun sort(entries: List<Entry>): List<Entry> =
        entries.sortedWith(compareBy<Entry>({ !it.isDir }, { it.name.lowercase(Locale.ROOT) }, { it.name }))

    // ---- Labels ----

    fun formatSize(bytes: Long): String {
        if (bytes < 1024) return "$bytes B"
        val units = arrayOf("KB", "MB", "GB", "TB")
        var value = bytes.toDouble() / 1024
        var i = 0
        while (value >= 1024 && i < units.lastIndex) {
            value /= 1024
            i++
        }
        return if (value >= 100) String.format(Locale.US, "%.0f %s", value, units[i])
        else String.format(Locale.US, "%.1f %s", value, units[i])
    }

    fun formatDate(ms: Long?, zone: TimeZone = TimeZone.getDefault()): String {
        if (ms == null) return ""
        return SimpleDateFormat("MMM d, yyyy", Locale.US).apply { timeZone = zone }.format(java.util.Date(ms))
    }

    fun subtitle(entry: Entry, zone: TimeZone = TimeZone.getDefault()): String {
        val date = formatDate(entry.modifiedMs, zone)
        return when {
            entry.isDir -> date
            date.isEmpty() -> formatSize(entry.size)
            else -> formatSize(entry.size) + " · " + date
        }
    }

    private val IMAGE = setOf("png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "svg", "tif", "tiff")
    private val VIDEO = setOf("mp4", "mov", "mkv", "avi", "webm", "m4v")
    private val AUDIO = setOf("mp3", "m4a", "wav", "flac", "ogg", "aac")
    private val ARCHIVE = setOf("zip", "rar", "7z", "tar", "gz", "tgz")
    private val DOC = setOf("pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "rtf", "json", "html")

    /** A simple icon for the row. */
    fun icon(entry: Entry, atRoot: Boolean = false): String {
        if (entry.isDir) return if (atRoot) "\uD83D\uDCBD" else "\uD83D\uDCC1"
        return when (entry.name.substringAfterLast('.', "").lowercase(Locale.ROOT)) {
            in IMAGE -> "\uD83D\uDDBC\uFE0F"
            in VIDEO -> "\uD83C\uDFAC"
            in AUDIO -> "\uD83C\uDFB5"
            in ARCHIVE -> "\uD83D\uDDDC\uFE0F"
            "apk" -> "\uD83D\uDCE6"
            in DOC -> "\uD83D\uDCC4"
            else -> "\uD83D\uDCC3"
        }
    }

    // ---- Errors ----

    /** A short message the user can act on. [body] is the host's own plain-text reason, when it gave one. */
    fun errorMessage(status: Int?, body: String = "", action: String = "do that"): String {
        val host = body.trim().lines().firstOrNull().orEmpty().take(160)
        return when (status) {
            null, 0 -> "Could not reach that machine. Is it on, and on your network or Tailscale?"
            401 -> "That machine no longer trusts this phone. Join it again from My machines."
            403 -> if (host.isNotEmpty()) host else "That machine does not allow this."
            404 -> "That item is gone. Pull down to refresh."
            405 -> "That machine does not allow this here."
            409 -> "Could not $action here. The name may be taken, or the folder is missing."
            413 -> "That file is too big for the machine to accept."
            507 -> "That machine is out of space."
            in 500..599 -> "That machine had a problem (HTTP $status)." + if (host.isNotEmpty()) " $host" else ""
            else -> "Could not $action (HTTP $status)."
        }
    }

    /** The host said the grant cannot write here. The browser hides that action afterwards. */
    fun isRefusal(status: Int?): Boolean = status == 403 || status == 405
}
