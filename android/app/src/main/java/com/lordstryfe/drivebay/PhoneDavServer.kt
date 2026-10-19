package com.lordstryfe.drivebay

import java.io.ByteArrayOutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Serves [DavProtocol] on the given local addresses only.
 * Callers pass Tailscale and LAN addresses, never a public one.
 */
class PhoneDavServer(
    private val store: DavStore,
    private val tokenHash: String,
    private val port: Int,
    private val bindHosts: List<String>,
) {
    private val running = AtomicBoolean(false)
    private val sockets = mutableListOf<ServerSocket>()

    fun start() {
        if (!running.compareAndSet(false, true)) return
        val hosts = bindHosts.filter { PhoneShareNet.isPrivateOrTailscale(it) }.distinct()
        if (hosts.isEmpty()) {
            running.set(false)
            return
        }
        for (host in hosts) {
            val server = ServerSocket()
            server.reuseAddress = true
            server.bind(InetSocketAddress(host, port))
            sockets += server
            Thread({
                while (running.get()) {
                    val client = try {
                        server.accept()
                    } catch (_: Exception) {
                        break
                    }
                    Thread({ handle(client) }, "drivebay-phone-dav").apply { isDaemon = true }.start()
                }
            }, "drivebay-phone-dav-accept").apply { isDaemon = true }.start()
        }
    }

    fun port(): Int = sockets.firstOrNull()?.localPort ?: port

    fun stop() {
        running.set(false)
        sockets.forEach { runCatching { it.close() } }
        sockets.clear()
    }

    private fun handle(socket: Socket) {
        socket.use { client ->
            client.soTimeout = 30_000
            val input = client.getInputStream()
            val headerBytes = ByteArrayOutputStream()
            while (true) {
                val b = input.read()
                if (b < 0) return
                headerBytes.write(b)
                val raw = headerBytes.toByteArray()
                if (raw.size >= 4 && raw[raw.size - 4] == '\r'.code.toByte() && raw[raw.size - 3] == '\n'.code.toByte() &&
                    raw[raw.size - 2] == '\r'.code.toByte() && raw[raw.size - 1] == '\n'.code.toByte()
                ) break
                if (headerBytes.size() > 64 * 1024) return
            }
            val head = String(headerBytes.toByteArray(), Charsets.ISO_8859_1)
            val lines = head.split("\r\n")
            val requestLine = lines.firstOrNull()?.split(" ") ?: return
            if (requestLine.size < 2) return
            val headers = linkedMapOf<String, String>()
            for (line in lines.drop(1)) {
                if (line.isBlank()) continue
                val colon = line.indexOf(':')
                if (colon <= 0) continue
                headers[line.substring(0, colon).trim()] = line.substring(colon + 1).trim()
            }
            val length = headers.entries.firstOrNull { it.key.equals("Content-Length", true) }?.value?.toIntOrNull() ?: 0
            if (length < 0 || length > 64 * 1024 * 1024) return
            val body = if (length == 0) ByteArray(0) else {
                val buf = ByteArray(length)
                var off = 0
                while (off < length) {
                    val n = input.read(buf, off, length - off)
                    if (n < 0) break
                    off += n
                }
                if (off == length) buf else buf.copyOf(off)
            }
            val response = DavProtocol.handle(
                DavRequest(requestLine[0].uppercase(Locale.US), requestLine[1], headers, body),
                store,
                tokenHash,
            )
            val status = "HTTP/1.1 ${response.status} ${response.reason}\r\n"
            val headerText = buildString {
                append(status)
                for ((key, value) in response.headers) append(key).append(": ").append(value).append("\r\n")
                if (response.headers.keys.none { it.equals("Content-Length", true) }) {
                    append("Content-Length: ").append(response.body.size).append("\r\n")
                }
                append("Connection: close\r\n\r\n")
            }
            val out = client.getOutputStream()
            out.write(headerText.toByteArray(Charsets.ISO_8859_1))
            out.write(response.body)
            out.flush()
        }
    }
}
