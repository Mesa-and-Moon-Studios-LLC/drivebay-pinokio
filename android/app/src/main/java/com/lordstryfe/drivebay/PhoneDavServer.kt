package com.lordstryfe.drivebay

import java.io.ByteArrayOutputStream
import java.net.BindException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Serves [DavProtocol] on the given local addresses only.
 * Callers pass Tailscale and LAN addresses, never a public one.
 * One address failing does not stop the others. If none bind, [start] throws
 * the first [BindException] (or a bind failure) so the service can log it and retry.
 * Only one server is listening in this process: [start] closes the previous
 * instance before it binds, and [stop] always closes the sockets it opened.
 */
class PhoneDavServer(
    private val store: DavStore,
    private val tokenHash: String,
    private val port: Int,
    private val bindHosts: List<String>,
    private val peerId: String? = null,
    codeState: PhoneShareCodeState? = null,
    onCodeLocked: () -> Unit = {},
) {
    private val gate = PhoneShareGate(tokenHash, codeState, onCodeLocked)

    private val running = AtomicBoolean(false)
    private val sockets = mutableListOf<ServerSocket>()
    private val acceptThreads = mutableListOf<Thread>()

    fun start() {
        // A restart can overlap the previous service. Close that listen socket first,
        // or the new bind fails with EADDRINUSE even when SO_REUSEADDR is set.
        val previous = claim(this)
        previous.forEach { it.closeSockets() }
        if (!running.compareAndSet(false, true)) {
            if (sockets.isEmpty()) throw BindException("No address to share on")
            return
        }
        val hosts = bindHosts.filter { PhoneShareNet.isPrivateOrTailscale(it) }.distinct()
        if (hosts.isEmpty()) {
            running.set(false)
            release(this)
            throw BindException("No address to share on")
        }
        var firstError: Exception? = null
        for (host in hosts) {
            val error = open(host)
            if (error != null && firstError == null) firstError = error
        }
        if (sockets.isEmpty()) {
            running.set(false)
            release(this)
            throw firstError ?: BindException("No address to share on")
        }
    }

    /** Bind addresses that came up after the server started, without dropping the ones already open. */
    fun bindMore(extra: List<String>): Boolean {
        if (!running.get()) return false
        var added = false
        for (host in extra.filter { PhoneShareNet.isPrivateOrTailscale(it) }.distinct()) {
            if (boundHosts().any { it.equals(host, ignoreCase = true) }) continue
            if (open(host) == null) added = true
        }
        return added
    }

    /**
     * Null when the socket is listening. The bind exception otherwise.
     * A just-closed listen socket can still report EADDRINUSE for a moment, so try a few times.
     */
    private fun open(host: String): Exception? {
        var last: Exception? = null
        repeat(8) { attempt ->
            last = openOnce(host)
            if (last == null || !PhoneShareLifecycle.isAddressInUse(last)) return last
            if (attempt < 7) Thread.sleep(15L * (attempt + 1))
        }
        return last
    }

    private fun openOnce(host: String): Exception? {
        val server = ServerSocket()
        return try {
            // SO_REUSEADDR on the unbound socket, before bind, so a port left in TIME_WAIT can be taken.
            server.setReuseAddress(true)
            server.soTimeout = 1_000
            server.bind(InetSocketAddress(host, port))
            val thread = Thread({
                while (running.get() && !server.isClosed) {
                    val client = try {
                        server.accept()
                    } catch (_: java.net.SocketTimeoutException) {
                        continue
                    } catch (_: Exception) {
                        break
                    }
                    Thread({ runCatching { handle(client) } }, "drivebay-phone-dav").apply { isDaemon = true }.start()
                }
            }, "drivebay-phone-dav-accept").apply { isDaemon = true }
            val kept = synchronized(sockets) {
                if (!running.get()) {
                    false
                } else {
                    sockets += server
                    acceptThreads += thread
                    true
                }
            }
            if (!kept) {
                runCatching { server.close() }
                return BindException("Server stopped during bind")
            }
            thread.start()
            null
        } catch (e: Exception) {
            runCatching { server.close() }
            e
        }
    }

    fun port(): Int = synchronized(sockets) { sockets.firstOrNull()?.localPort ?: port }

    fun boundHosts(): List<String> = synchronized(sockets) {
        sockets.mapNotNull { socket ->
            (socket.localSocketAddress as? InetSocketAddress)?.address?.hostAddress?.substringBefore('%')
        }
    }

    fun stop() {
        closeSockets()
        release(this)
    }

    /** Closes every listen socket and waits until accept() has dropped it. Safe to call twice. */
    private fun closeSockets() {
        val open: List<ServerSocket>
        val threads: List<Thread>
        synchronized(sockets) {
            running.set(false)
            open = sockets.toList()
            threads = acceptThreads.toList()
            sockets.clear()
            acceptThreads.clear()
        }
        open.forEach { runCatching { it.close() } }
        val self = Thread.currentThread()
        threads.forEach { thread ->
            if (thread !== self) runCatching { thread.join(500) }
        }
    }

    companion object {
        private val activeLock = Any()
        private val live = ArrayList<PhoneDavServer>()

        /** Registers [server] as a listener and returns every other live instance so the caller can close them. */
        private fun claim(server: PhoneDavServer): List<PhoneDavServer> = synchronized(activeLock) {
            val previous = live.filter { it !== server }
            live.clear()
            live.add(server)
            previous
        }

        private fun release(server: PhoneDavServer) {
            synchronized(activeLock) {
                live.remove(server)
            }
        }
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
                DavRequest(
                    requestLine[0].uppercase(Locale.US),
                    requestLine[1],
                    headers,
                    body,
                    client.inetAddress?.hostAddress,
                ),
                store,
                gate,
                peerId,
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
