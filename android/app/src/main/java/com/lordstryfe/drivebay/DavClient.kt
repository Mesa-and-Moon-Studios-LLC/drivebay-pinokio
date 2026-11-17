package com.lordstryfe.drivebay

import java.io.ByteArrayOutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import javax.net.ssl.SSLSocketFactory

/**
 * Minimal WebDAV PROPFIND over a plain socket.
 *
 * Android's HttpURLConnection throws ProtocolException for any method outside
 * OPTIONS/GET/HEAD/POST/PUT/DELETE/TRACE, so `requestMethod = "PROPFIND"` crashes the
 * app. This sends the request itself (HTTP/1.0, so the reply is not chunked) and never throws.
 */
object DavClient {
    data class Reply(val status: Int, val body: String)

    fun propfind(
        url: String,
        basicAuth: String,
        depth: String = "1",
        timeoutMs: Int = 8000,
        socketFactory: (String, Int, Boolean) -> Socket = ::openSocket,
    ): Reply? {
        return try {
            val uri = URI(url)
            val secure = uri.scheme.equals("https", ignoreCase = true)
            val host = uri.host ?: return null
            val port = if (uri.port > 0) uri.port else if (secure) 443 else 80
            val path = (uri.rawPath?.takeIf { it.isNotEmpty() } ?: "/") + (uri.rawQuery?.let { "?$it" } ?: "")
            val request = "PROPFIND $path HTTP/1.0\r\n" +
                "Host: ${uri.authority}\r\n" +
                "Depth: $depth\r\n" +
                "Authorization: Basic $basicAuth\r\n" +
                "Content-Length: 0\r\n" +
                "Connection: close\r\n\r\n"
            socketFactory(host, port, secure).use { socket ->
                socket.soTimeout = timeoutMs
                socket.getOutputStream().apply { write(request.toByteArray(Charsets.ISO_8859_1)); flush() }
                val out = ByteArrayOutputStream()
                val buf = ByteArray(8192)
                val input = socket.getInputStream()
                while (out.size() < MAX_BYTES) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                }
                parse(out.toByteArray())
            }
        } catch (_: Exception) {
            null
        }
    }

    fun parse(raw: ByteArray): Reply? {
        val text = String(raw, Charsets.UTF_8)
        val split = text.indexOf("\r\n\r\n")
        if (split < 0) return null
        val head = text.substring(0, split)
        val status = head.lineSequence().firstOrNull()?.split(" ")?.getOrNull(1)?.toIntOrNull() ?: return null
        var body = text.substring(split + 4)
        if (head.lines().any { it.startsWith("Transfer-Encoding:", ignoreCase = true) && it.contains("chunked", ignoreCase = true) }) {
            body = unchunk(body)
        }
        return Reply(status, body)
    }

    private fun unchunk(body: String): String {
        val out = StringBuilder()
        var i = 0
        while (i < body.length) {
            val eol = body.indexOf("\r\n", i)
            if (eol < 0) break
            val size = body.substring(i, eol).substringBefore(';').trim().toIntOrNull(16) ?: break
            if (size == 0) break
            val start = eol + 2
            if (start + size > body.length) { out.append(body.substring(start)); break }
            out.append(body, start, start + size)
            i = start + size + 2
        }
        return out.toString()
    }

    private fun openSocket(host: String, port: Int, secure: Boolean): Socket {
        val plain = Socket()
        plain.connect(InetSocketAddress(host, port), 8000)
        return if (secure) (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(plain, host, port, true) else plain
    }

    private const val MAX_BYTES = 4 * 1024 * 1024
}
