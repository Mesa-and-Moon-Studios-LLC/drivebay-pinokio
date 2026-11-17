package com.lordstryfe.drivebay

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.nio.file.Files

/** A tiny raw-socket WebDAV host plus an HttpServer for GET and PUT, to exercise the real client code. */
class DavSessionTest {
    private lateinit var server: java.net.ServerSocket
    private val seen = java.util.Collections.synchronizedList(mutableListOf<String>())
    private var reply = "HTTP/1.1 207 Multi-Status\r\n\r\n"
    private var running = true

    @Before fun start() {
        server = java.net.ServerSocket(0)
        Thread {
            while (running) {
                val s = try { server.accept() } catch (_: Exception) { break }
                s.use {
                    val input = it.getInputStream()
                    val sb = StringBuilder()
                    while (!sb.endsWith("\r\n\r\n")) {
                        val c = input.read()
                        if (c < 0) break
                        sb.append(c.toChar())
                    }
                    seen.add(sb.toString())
                    it.getOutputStream().apply { write(reply.toByteArray()); flush() }
                }
            }
        }.start()
    }

    @After fun stop() { running = false; server.close() }

    private fun session() = DavSession("http://127.0.0.1:${server.localPort}/dav/", "tok")

    @Test fun listsAFolderOverPropfindDepthOne() {
        val xml = """<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/</d:href></d:response><d:response><d:href>/dav/Home/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>"""
        reply = "HTTP/1.1 207 Multi-Status\r\n\r\n$xml"
        val result = session().list("/") as DavSession.Listing.Ok
        assertEquals(listOf("Home"), result.entries.map { it.name })
        assertTrue(seen[0].startsWith("PROPFIND /dav/ HTTP/1.0"))
        assertTrue(seen[0].contains("Depth: 1"))
        assertTrue(seen[0].contains("Authorization: Basic " + DavBrowse.basicAuth("tok")))
    }

    @Test fun aRefusedListingGivesTheHostsReason() {
        reply = "HTTP/1.1 403 Forbidden\r\n\r\nThat path is not shared."
        val fail = session().list("/Nope/") as DavSession.Listing.Fail
        assertEquals(403, fail.status)
        assertEquals("That path is not shared.", fail.message)
    }

    @Test fun anUnreachableHostIsAMessageNotACrash() {
        val dead = DavSession("http://127.0.0.1:1/dav/", "tok")
        val fail = dead.list("/") as DavSession.Listing.Fail
        assertEquals(null, fail.status)
        assertTrue(fail.message.contains("Could not reach"))
        assertFalse(dead.makeFolder("/Home/x/").ok)
    }

    @Test fun makesFoldersWithMkcol() {
        reply = "HTTP/1.1 201 Created\r\n\r\n"
        val op = session().makeFolder("/Home/New folder/")
        assertTrue(op.ok)
        assertTrue(seen[0].startsWith("MKCOL /dav/Home/New%20folder/ HTTP/1.0"))
    }

    @Test fun renamesWithMoveAndADestinationHeader() {
        reply = "HTTP/1.1 201 Created\r\n\r\n"
        val op = session().move("/Home/a b.txt", "/Home/c d.txt", false)
        assertTrue(op.ok)
        assertTrue(seen[0].startsWith("MOVE /dav/Home/a%20b.txt HTTP/1.0"))
        assertTrue(seen[0].contains("Destination: http://127.0.0.1:${server.localPort}/dav/Home/c%20d.txt"))
    }

    @Test fun deletesWithDelete() {
        reply = "HTTP/1.1 204 No Content\r\n\r\n"
        assertTrue(session().delete("/Home/old/", true).ok)
        assertTrue(seen[0].startsWith("DELETE /dav/Home/old/ HTTP/1.0"))
    }

    @Test fun aHostThatTurnsAWriteOffComesBackAsARefusalWithItsMessage() {
        reply = "HTTP/1.1 403 Forbidden\r\n\r\nDelete is turned off on this machine."
        val op = session().delete("/Home/x", false)
        assertFalse(op.ok)
        assertEquals(403, op.status)
        assertEquals("Delete is turned off on this machine.", op.message)
        assertTrue(DavBrowse.isRefusal(op.status))
    }

    @Test fun aRevokedGrantIs401() {
        reply = "HTTP/1.1 401 Unauthorized\r\n\r\nSign in required"
        val fail = session().list("/") as DavSession.Listing.Fail
        assertEquals(401, fail.status)
        assertTrue(fail.message.contains("Join it again"))
    }

    // ---- GET and PUT with progress ----

    /** A small HTTP/1.1 server on a socket. The handler gets method, path and body, and returns status and body. */
    private class MiniHttp(val handler: (String, String, ByteArray) -> Pair<Int, ByteArray>) {
        val socket = java.net.ServerSocket(0)
        @Volatile var open = true
        init {
            Thread {
                while (open) {
                    val s = try { socket.accept() } catch (_: Exception) { break }
                    Thread { try { s.use { serve(it) } } catch (_: Exception) {} }.start()
                }
            }.start()
        }
        val port get() = socket.localPort
        fun close() { open = false; socket.close() }

        private fun readLine(input: java.io.InputStream): String? {
            val sb = StringBuilder()
            while (true) {
                val c = input.read()
                if (c < 0) return if (sb.isEmpty()) null else sb.toString()
                if (c == '\n'.code) return sb.toString().trimEnd('\r')
                sb.append(c.toChar())
            }
        }

        private fun serve(s: java.net.Socket) {
            val input = java.io.BufferedInputStream(s.getInputStream())
            val first = readLine(input) ?: return
            val (method, path) = first.split(" ").let { it[0] to it[1] }
            var length = -1
            var chunked = false
            while (true) {
                val line = readLine(input) ?: break
                if (line.isEmpty()) break
                if (line.startsWith("Content-Length:", true)) length = line.substringAfter(":").trim().toInt()
                if (line.startsWith("Transfer-Encoding:", true) && line.contains("chunked", true)) chunked = true
            }
            val body = java.io.ByteArrayOutputStream()
            if (chunked) {
                while (true) {
                    val size = readLine(input)!!.trim().toInt(16)
                    if (size == 0) { readLine(input); break }
                    body.write(input.readNBytes(size))
                    readLine(input)
                }
            } else if (length > 0) {
                body.write(input.readNBytes(length))
            }
            val (status, payload) = handler(method, path, body.toByteArray())
            val out = s.getOutputStream()
            out.write("HTTP/1.1 $status X\r\nContent-Length: ${payload.size}\r\nConnection: close\r\n\r\n".toByteArray())
            out.write(payload)
            out.flush()
        }
    }

    @Test fun downloadsWithProgressAndCancels() {
        val payload = ByteArray(300_000) { (it % 251).toByte() }
        val http = MiniHttp { _, path, _ ->
            if (path.endsWith("denied.bin")) 403 to "Denied".toByteArray() else 200 to payload
        }
        try {
            val base = "http://127.0.0.1:${http.port}/dav/"
            val dest = File.createTempFile("dav", ".part")
            var last = 0L
            val ok = DavTransfer.download(DavBrowse.urlFor(base, "/Home/big.bin"), "x", dest, { d, _ -> last = d }, { false })
            assertTrue(ok.ok)
            assertEquals(payload.size.toLong(), dest.length())
            assertEquals(payload.size.toLong(), last)
            assertTrue(payload.contentEquals(dest.readBytes()))
            val stopped = DavTransfer.download(DavBrowse.urlFor(base, "/Home/big.bin"), "x", dest, { _, _ -> }, { true })
            assertTrue(stopped.cancelled)
            assertFalse(dest.exists())
            val denied = DavTransfer.download(DavBrowse.urlFor(base, "/Home/denied.bin"), "x", dest, { _, _ -> }, { false })
            assertEquals(403, denied.status)
            assertEquals("Denied", denied.message)
        } finally {
            http.close()
        }
    }

    @Test fun uploadsWithPutAndReportsTheHostsAnswer() {
        val dir = Files.createTempDirectory("davput").toFile()
        val http = MiniHttp { method, path, body ->
            assertEquals("PUT", method)
            val name = java.net.URLDecoder.decode(path.substringAfterLast('/'), "UTF-8")
            if (name == "readonly.txt") 403 to "That folder is read-only.".toByteArray()
            else { File(dir, name).writeBytes(body); 201 to ByteArray(0) }
        }
        try {
            val base = "http://127.0.0.1:${http.port}/dav/"
            val data = ByteArray(200_000) { (it % 7).toByte() }
            val ok = DavTransfer.upload(DavBrowse.urlFor(base, "/Home/up one.bin"), "x", ByteArrayInputStream(data), data.size.toLong(), { _, _ -> }, { false })
            assertTrue(ok.ok)
            assertTrue(data.contentEquals(File(dir, "up one.bin").readBytes()))
            val chunked = DavTransfer.upload(DavBrowse.urlFor(base, "/Home/unknown size.bin"), "x", ByteArrayInputStream(data), -1, { _, _ -> }, { false })
            assertTrue(chunked.ok)
            assertTrue(data.contentEquals(File(dir, "unknown size.bin").readBytes()))
            val ro = DavTransfer.upload(DavBrowse.urlFor(base, "/Home/readonly.txt"), "x", ByteArrayInputStream(data), data.size.toLong(), { _, _ -> }, { false })
            assertEquals(403, ro.status)
            assertEquals("That folder is read-only.", ro.message)
        } finally {
            http.close()
            dir.deleteRecursively()
        }
    }

    @Test fun transfersToADeadHostReturnStatusZeroAndNeverThrow() {
        val dest = File.createTempFile("dav", ".part")
        assertEquals(0, DavTransfer.download("http://127.0.0.1:1/dav/x", "x", dest, { _, _ -> }, { false }).status)
        assertEquals(0, DavTransfer.upload("http://127.0.0.1:1/dav/x", "x", ByteArrayInputStream(ByteArray(3)), 3, { _, _ -> }, { false }).status)
        dest.delete()
    }
}
