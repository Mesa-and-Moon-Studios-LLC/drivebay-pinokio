package com.lordstryfe.drivebay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ServerSocket
import kotlin.concurrent.thread

class DavClientTest {
    private fun serve(reply: String, seen: MutableList<String>): ServerSocket {
        val server = ServerSocket(0)
        thread {
            server.accept().use { s ->
                val input = s.getInputStream()
                val sb = StringBuilder()
                while (!sb.endsWith("\r\n\r\n")) sb.append(input.read().toChar())
                seen.add(sb.toString())
                s.getOutputStream().apply { write(reply.toByteArray()); flush() }
            }
        }
        return server
    }

    @Test fun sendsPropfindWithoutHttpUrlConnectionAndReadsBody() {
        val seen = mutableListOf<String>()
        val xml = "<a:multistatus xmlns:a=\"DAV:\"/>"
        val server = serve("HTTP/1.1 207 Multi-Status\r\nContent-Type: text/xml\r\n\r\n$xml", seen)
        val reply = DavClient.propfind("http://127.0.0.1:${server.localPort}/dav", "dXNlcjpwdw==")
        assertEquals(207, reply?.status)
        assertEquals(xml, reply?.body)
        assertTrue(seen[0].startsWith("PROPFIND /dav HTTP/1.0\r\n"))
        assertTrue(seen[0].contains("Depth: 1\r\n"))
        assertTrue(seen[0].contains("Authorization: Basic dXNlcjpwdw==\r\n"))
        server.close()
    }

    @Test fun decodesChunkedBodies() {
        val raw = "HTTP/1.1 207 X\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"
        assertEquals("hello world", DavClient.parse(raw.toByteArray())?.body)
    }

    @Test fun neverThrowsOnUnreachableOrBadInput() {
        assertNull(DavClient.propfind("http://127.0.0.1:1/dav", "x", timeoutMs = 500))
        assertNull(DavClient.propfind("not a url", "x"))
        assertNull(DavClient.parse("garbage".toByteArray()))
    }
}
