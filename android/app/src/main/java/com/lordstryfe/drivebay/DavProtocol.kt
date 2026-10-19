package com.lordstryfe.drivebay

import java.net.URLDecoder
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

data class DavNode(
    val path: String,
    val name: String,
    val directory: Boolean,
    val size: Long,
    val modifiedMs: Long,
)

interface DavStore {
    fun list(path: String): List<DavNode>?
    fun stat(path: String): DavNode?
    fun read(path: String): ByteArray?
    fun put(path: String, bytes: ByteArray): Boolean
    fun delete(path: String): Boolean
    fun mkcol(path: String): Boolean
    fun move(from: String, to: String): Boolean
}

data class DavRequest(
    val method: String,
    val path: String,
    val headers: Map<String, String>,
    val body: ByteArray = ByteArray(0),
)

data class DavResponse(
    val status: Int,
    val reason: String,
    val headers: Map<String, String> = emptyMap(),
    val body: ByteArray = ByteArray(0),
)

/**
 * Small WebDAV handler. Windows, macOS, and Linux can mount a server that
 * answers these methods. LOCK is a token Windows asks for before it writes.
 */
object DavProtocol {
    private val httpDate: DateTimeFormatter =
        DateTimeFormatter.RFC_1123_DATE_TIME.withLocale(Locale.US).withZone(ZoneOffset.UTC)

    fun handle(request: DavRequest, store: DavStore, tokenHash: String): DavResponse {
        val method = request.method.uppercase(Locale.US)
        if (method != "OPTIONS" && !PhoneShareAuth.authorized(header(request, "authorization"), tokenHash)) {
            return text(401, "Unauthorized", mapOf("WWW-Authenticate" to "Basic realm=\"Drivebay\""), "Sign in required")
        }
        val path = normalize(request.path) ?: return text(400, "Bad Request", emptyMap(), "Bad path")
        return when (method) {
            "OPTIONS" -> DavResponse(
                200,
                "OK",
                mapOf(
                    "DAV" to "1, 2",
                    "Allow" to "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE, LOCK, UNLOCK",
                    "Content-Length" to "0",
                ),
            )
            "PROPFIND" -> propfind(store, path, header(request, "depth"))
            "GET" -> get(store, path, head = false)
            "HEAD" -> get(store, path, head = true)
            "PUT" -> if (store.put(path, request.body)) text(201, "Created", emptyMap(), "") else text(409, "Conflict", emptyMap(), "Cannot write")
            "DELETE" -> if (store.delete(path)) DavResponse(204, "No Content") else text(404, "Not Found", emptyMap(), "Missing")
            "MKCOL" -> if (store.mkcol(path)) DavResponse(201, "Created") else text(409, "Conflict", emptyMap(), "Cannot create")
            "MOVE" -> move(store, path, header(request, "destination"))
            "LOCK" -> lock(path)
            "UNLOCK" -> DavResponse(204, "No Content")
            else -> text(405, "Method Not Allowed", mapOf("Allow" to "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE, LOCK, UNLOCK"), "")
        }
    }

    fun normalize(raw: String): String? {
        val decoded = try {
            URLDecoder.decode(raw.substringBefore('?'), "UTF-8")
        } catch (_: Exception) {
            return null
        }
        if (decoded.contains('\u0000')) return null
        val parts = decoded.split('/').filter { it.isNotEmpty() }
        if (parts.any { it == ".." || it == "." }) return null
        return "/" + parts.joinToString("/")
    }

    private fun propfind(store: DavStore, path: String, depthHeader: String?): DavResponse {
        val depth = depthHeader?.trim()?.lowercase(Locale.US) ?: "1"
        if (depth == "infinity") return text(403, "Forbidden", emptyMap(), "Depth infinity is not allowed")
        val self = store.stat(path) ?: return text(404, "Not Found", emptyMap(), "Missing")
        val nodes = mutableListOf(self)
        if (depth != "0" && self.directory) {
            nodes += store.list(path).orEmpty()
        }
        val xml = buildString {
            append("""<?xml version="1.0" encoding="utf-8"?>""")
            append("""<d:multistatus xmlns:d="DAV:">""")
            for (node in nodes) {
                val href = if (node.directory && !node.path.endsWith("/")) node.path + "/" else node.path
                append("<d:response><d:href>")
                append(xmlEscape(href))
                append("</d:href><d:propstat><d:prop>")
                append("<d:displayname>")
                append(xmlEscape(node.name))
                append("</d:displayname>")
                if (node.directory) append("<d:resourcetype><d:collection/></d:resourcetype>")
                else append("<d:resourcetype/>")
                append("<d:getcontentlength>")
                append(if (node.directory) 0 else node.size)
                append("</d:getcontentlength>")
                append("<d:getlastmodified>")
                append(xmlEscape(httpDate.format(Instant.ofEpochMilli(node.modifiedMs))))
                append("</d:getlastmodified>")
                append("</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>")
            }
            append("</d:multistatus>")
        }
        val bytes = xml.toByteArray(Charsets.UTF_8)
        return DavResponse(
            207,
            "Multi-Status",
            mapOf("Content-Type" to "application/xml; charset=utf-8", "Content-Length" to bytes.size.toString()),
            bytes,
        )
    }

    private fun get(store: DavStore, path: String, head: Boolean): DavResponse {
        val node = store.stat(path) ?: return text(404, "Not Found", emptyMap(), "Missing")
        if (node.directory) return text(405, "Method Not Allowed", emptyMap(), "Folder")
        val bytes = if (head) ByteArray(0) else store.read(path) ?: return text(404, "Not Found", emptyMap(), "Missing")
        return DavResponse(
            200,
            "OK",
            mapOf(
                "Content-Type" to "application/octet-stream",
                "Content-Length" to node.size.toString(),
                "Accept-Ranges" to "bytes",
            ),
            bytes,
        )
    }

    private fun move(store: DavStore, from: String, destination: String?): DavResponse {
        if (destination.isNullOrBlank()) return text(400, "Bad Request", emptyMap(), "Missing Destination")
        val path = destination.substringAfter("://").let { rest ->
            val slash = rest.indexOf('/')
            if (slash < 0) "/" else rest.substring(slash)
        }
        val target = normalize(path) ?: return text(400, "Bad Request", emptyMap(), "Bad Destination")
        return if (store.move(from, target)) DavResponse(201, "Created") else text(404, "Not Found", emptyMap(), "Missing")
    }

    private fun lock(path: String): DavResponse {
        val token = "opaquelocktoken:" + PhoneShareAuth.hash(path).take(32)
        val xml = """<?xml version="1.0" encoding="utf-8"?>
<d:prop xmlns:d="DAV:"><d:lockdiscovery><d:activelock>
<d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope>
<d:depth>infinity</d:depth><d:timeout>Second-3600</d:timeout>
<d:locktoken><d:href>$token</d:href></d:locktoken>
</d:activelock></d:lockdiscovery></d:prop>"""
        val bytes = xml.toByteArray(Charsets.UTF_8)
        return DavResponse(
            200,
            "OK",
            mapOf(
                "Content-Type" to "application/xml; charset=utf-8",
                "Lock-Token" to "<$token>",
                "Content-Length" to bytes.size.toString(),
            ),
            bytes,
        )
    }

    private fun header(request: DavRequest, name: String): String? =
        request.headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value

    private fun text(status: Int, reason: String, headers: Map<String, String>, body: String): DavResponse {
        val bytes = body.toByteArray(Charsets.UTF_8)
        return DavResponse(status, reason, headers + mapOf("Content-Length" to bytes.size.toString(), "Content-Type" to "text/plain; charset=utf-8"), bytes)
    }

    fun xmlEscape(value: String): String = buildString(value.length) {
        for (ch in value) {
            when (ch) {
                '&' -> append("&amp;")
                '<' -> append("&lt;")
                '>' -> append("&gt;")
                '"' -> append("&quot;")
                else -> append(ch)
            }
        }
    }
}

/** In-memory store used by unit tests and as the shape the phone folders follow. */
class MemoryDavStore : DavStore {
    private val dirs = mutableSetOf("/")
    private val files = linkedMapOf<String, ByteArray>()

    override fun list(path: String): List<DavNode>? {
        val dir = if (path.endsWith("/")) path else "$path/"
        if (stat(path)?.directory != true && path != "/") return null
        val prefix = if (path == "/") "/" else dir
        val names = linkedSetOf<String>()
        val nodes = mutableListOf<DavNode>()
        for (file in files.keys) {
            if (!file.startsWith(prefix) || file == path) continue
            val rest = file.removePrefix(prefix)
            val child = rest.substringBefore('/')
            if (child.isEmpty() || !names.add(child)) continue
            val childPath = prefix + child
            if (rest.contains('/')) nodes += DavNode(childPath, child, true, 0, 0)
            else nodes += stat(childPath) ?: continue
        }
        for (folder in dirs) {
            if (folder == "/" || folder == path) continue
            val trimmed = folder.trimEnd('/')
            if (!trimmed.startsWith(prefix)) continue
            val rest = trimmed.removePrefix(prefix)
            if (rest.isEmpty() || rest.contains('/')) continue
            if (!names.add(rest)) continue
            nodes += DavNode(trimmed, rest, true, 0, 0)
        }
        return nodes
    }

    override fun stat(path: String): DavNode? {
        val clean = if (path.isEmpty()) "/" else path
        if (clean == "/" || dirs.contains(clean) || dirs.contains("$clean/")) {
            return DavNode(if (clean == "/") "/" else clean.trimEnd('/'), clean.trim('/').substringAfterLast('/').ifBlank { "Drivebay" }, true, 0, 0)
        }
        val bytes = files[clean] ?: return null
        return DavNode(clean, clean.substringAfterLast('/'), false, bytes.size.toLong(), 0)
    }

    override fun read(path: String): ByteArray? = files[path]

    override fun put(path: String, bytes: ByteArray): Boolean {
        val parent = path.substringBeforeLast('/', "/")
        if (parent != "/" && stat(parent)?.directory != true && !dirs.contains(parent)) return false
        if (parent != "/" && parent.isNotEmpty()) dirs.add(parent)
        files[path] = bytes
        return true
    }

    override fun delete(path: String): Boolean {
        if (path == "/") return false
        val file = files.remove(path) != null
        val folder = dirs.remove(path) || dirs.remove("$path/")
        val nested = files.keys.filter { it.startsWith("$path/") }.toList()
        nested.forEach { files.remove(it) }
        dirs.removeAll { it.startsWith("$path/") }
        return file || folder || nested.isNotEmpty()
    }

    override fun mkcol(path: String): Boolean {
        if (stat(path) != null) return false
        val parent = path.substringBeforeLast('/', "/")
        if (parent.isNotEmpty() && parent != "/" && stat(parent)?.directory != true) return false
        dirs.add(path)
        return true
    }

    override fun move(from: String, to: String): Boolean {
        val bytes = files.remove(from) ?: return false
        files[to] = bytes
        return true
    }
}
