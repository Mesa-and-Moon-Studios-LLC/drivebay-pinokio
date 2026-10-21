package com.lordstryfe.drivebay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.InetSocketAddress
import java.net.Socket

class ServerProfilesTest {
    @Test fun keyIgnoresPathAndSlash() {
        assertEquals(
            ServerProfiles.keyOf("http://100.64.0.2:8765/files/"),
            ServerProfiles.keyOf("http://100.64.0.2:8765"),
        )
    }

    @Test fun loginPathOnly() {
        assertTrue(ServerProfiles.isLoginUrl("http://pc:8765/login"))
        assertFalse(ServerProfiles.isLoginUrl("http://pc:8765/"))
        assertFalse(ServerProfiles.isLoginUrl("http://pc:8765/login-help"))
    }

    @Test fun jsStringEscapes() {
        assertEquals("\"a\\\\b\\\"c\"", ServerProfiles.jsString("a\\b\"c"))
        assertFalse(ServerProfiles.jsString("<script>").contains("<"))
    }
}

class UploadPickerTest {
    @Test fun mimeFallsBack() {
        assertEquals(listOf("*/*"), UploadPicker.mimeTypes(null))
        assertEquals(listOf("*/*"), UploadPicker.mimeTypes(arrayOf("", "*/*")))
        assertEquals(listOf("image/png"), UploadPicker.mimeTypes(arrayOf("image/png")))
    }

    @Test fun uploadUrlRejectsSlashes() {
        assertNull(UploadPicker.rawUploadUrl("http://pc:8765/folder", "C:/Drive", "a/b"))
        assertEquals(
            "http://pc:8765/api/upload?parent=C%3A%5CDrive&name=photo.jpg",
            UploadPicker.rawUploadUrl("http://pc:8765/files/a", "C:\\Drive", "photo.jpg"),
        )
    }

    @Test fun cacheNameStripsPath() {
        assertTrue(UploadPicker.cacheName("../etc/passwd", 2).startsWith("2-"))
        assertFalse(UploadPicker.cacheName("../etc/passwd", 2).contains("/"))
    }
}

class DownloadsOrderTest {
    private fun job(state: String) = DownloadJob(
        id = state, url = "http://pc/api/download?path=a", fileName = "$state.bin", cookie = "",
        userAgent = "", totalBytes = 10, downloadedBytes = 4, etag = null, mime = null,
        wifiOnly = false, state = state, error = null, createdAt = 1,
    )

    @Test fun pausedAndFailedStayInTheList() {
        val jobs = listOf(job(DownloadJob.STATE_PAUSED), job(DownloadJob.STATE_FAILED), job("done"))
        assertEquals(2, DownloadsOrder.needsAttention(jobs))
        assertEquals(DownloadJob.STATE_PAUSED, DownloadsOrder.incomplete(jobs).first().state)
        assertEquals("Paused", DownloadsOrder.label(job(DownloadJob.STATE_PAUSED)))
    }
}

class PhoneShareTest {
    @Test fun tokenRoundTrip() {
        val token = PhoneShareAuth.generateToken()
        assertTrue(PhoneShareAuth.looksLikeToken(token))
        val hash = PhoneShareAuth.hash(token)
        assertTrue(PhoneShareAuth.matches(token, hash))
        assertFalse(PhoneShareAuth.matches(token.replaceRange(3, 5, "00"), hash))
        val header = PhoneShareAuth.basicHeader(PhoneShareAuth.USER, token)
        assertTrue(PhoneShareAuth.authorized(header, hash))
        assertFalse(PhoneShareAuth.authorized("Basic nope", hash))
    }

    @Test fun onlyPrivateAndTailscale() {
        assertTrue(PhoneShareNet.isPrivateOrTailscale("100.64.1.8"))
        assertTrue(PhoneShareNet.isPrivateOrTailscale("192.168.1.20"))
        assertTrue(PhoneShareNet.isPrivateOrTailscale("10.1.2.3"))
        assertFalse(PhoneShareNet.isPrivateOrTailscale("8.8.8.8"))
        assertFalse(PhoneShareNet.isPrivateOrTailscale("1.1.1.1"))
        assertTrue(PhoneShareNet.isPrivateOrTailscale("fd7a:115c:a1e0::1"))
        assertFalse(PhoneShareNet.isPrivateOrTailscale("2001:db8::1"))
    }
}

class DavProtocolTest {
    @Test fun authAndPropfind() {
        val store = MemoryDavStore()
        assertTrue(store.mkcol("/Camera"))
        assertTrue(store.put("/Camera/a.txt", "hi".toByteArray()))
        val token = PhoneShareAuth.generateToken()
        stored = token
        val hash = PhoneShareAuth.hash(token)
        val denied = DavProtocol.handle(DavRequest("PROPFIND", "/", mapOf("Depth" to "1")), store, hash)
        assertEquals(401, denied.status)
        val header = PhoneShareAuth.basicHeader(PhoneShareAuth.USER, stored)
        val listing = DavProtocol.handle(
            DavRequest("PROPFIND", "/", mapOf("Authorization" to header, "Depth" to "1")),
            store,
            hash,
        )
        assertEquals(207, listing.status)
        val xml = String(listing.body, Charsets.UTF_8)
        assertTrue(xml.contains("/Camera"))
        val got = DavProtocol.handle(DavRequest("GET", "/Camera/a.txt", mapOf("Authorization" to header)), store, hash)
        assertEquals("hi", String(got.body, Charsets.UTF_8))
        val escaped = DavProtocol.handle(
            DavRequest("PROPFIND", "/nope/../Camera", mapOf("Authorization" to header)),
            store,
            hash,
        )
        assertEquals(400, escaped.status)
    }

    @Test fun optionsNeedNoPassword() {
        val hash = PhoneShareAuth.hash("db_" + "ab".repeat(32))
        val response = DavProtocol.handle(DavRequest("OPTIONS", "/", emptyMap()), MemoryDavStore(), hash)
        assertEquals(200, response.status)
        assertTrue(response.headers.getValue("Allow").contains("LOCK"))
    }

    @Test fun optionsCarryPeerId() {
        val hash = PhoneShareAuth.hash("db_" + "ab".repeat(32))
        val peer = PhoneShareLifecycle.peerId(hash)
        val response = DavProtocol.handle(DavRequest("OPTIONS", "/", emptyMap()), MemoryDavStore(), hash, peer)
        assertEquals(peer, response.headers[PhoneShareLifecycle.PEER_HEADER])
    }

    private var stored: String = ""
}

class PhoneShareLifecycleTest {
    @Test fun resumeNeedsSavedTokenAndAFolder() {
        val hash = PhoneShareAuth.hash(PhoneShareAuth.generateToken())
        assertTrue(PhoneShareLifecycle.shouldResume(true, hash, 1))
        assertFalse(PhoneShareLifecycle.shouldResume(false, hash, 1))
        assertFalse(PhoneShareLifecycle.shouldResume(true, null, 1))
        assertFalse(PhoneShareLifecycle.shouldResume(true, hash, 0))
        assertTrue(PhoneShareLifecycle.shouldResume(true, hash, 0, wholePhone = true))
        assertEquals(16, PhoneShareLifecycle.peerId(hash)!!.length)
    }

    @Test fun retryBackoffCaps() {
        assertEquals(1_000L, PhoneShareLifecycle.retryDelayMs(0))
        assertEquals(2_000L, PhoneShareLifecycle.retryDelayMs(1))
        assertEquals(4_000L, PhoneShareLifecycle.retryDelayMs(2))
        assertEquals(30_000L, PhoneShareLifecycle.retryDelayMs(20))
    }

    @Test fun addressInUseRetriesThenGivesUp() {
        assertTrue(PhoneShareLifecycle.isAddressInUse(java.net.BindException("Address already in use")))
        assertTrue(PhoneShareLifecycle.isAddressInUse(java.net.BindException("bind failed: EADDRINUSE (Address already in use)")))
        assertTrue(PhoneShareLifecycle.isAddressInUse(RuntimeException("start", java.net.BindException("Address already in use"))))
        assertTrue(PhoneShareLifecycle.isAddressInUse(ErrnoLike("bind failed", PhoneShareLifecycle.EADDRINUSE)))
        assertFalse(PhoneShareLifecycle.isAddressInUse(java.net.BindException("No address to share on")))
        assertFalse(PhoneShareLifecycle.isAddressInUse(ErrnoLike("network is down", 101)))
        assertFalse(PhoneShareLifecycle.isAddressInUse(null))
        assertFalse(PhoneShareLifecycle.portInUseExhausted(0))
        assertFalse(PhoneShareLifecycle.portInUseExhausted(PhoneShareLifecycle.PORT_IN_USE_TRIES - 1))
        assertTrue(PhoneShareLifecycle.portInUseExhausted(PhoneShareLifecycle.PORT_IN_USE_TRIES))
        assertEquals(5, PhoneShareLifecycle.PORT_IN_USE_TRIES)
    }

    private class ErrnoLike(message: String, private val errno: Int) : Exception(message) {
        fun getErrno(): Int = errno
    }

    @Test fun bannerSitsAboveTheList() {
        val top = ShareScreenLayout.listTop(statusBarInsetPx = 80, bannerHeightPx = 140, bannerVisible = true)
        assertEquals(220, top)
        assertTrue(ShareScreenLayout.firstRowVisible(80, 140, true, top))
        assertFalse(ShareScreenLayout.firstRowVisible(80, 140, true, top - 1))
        assertEquals(80, ShareScreenLayout.listTop(80, 140, bannerVisible = false))
        val text = PhoneShareLifecycle.bannerText("This phone is shared as a drive", "Connected", "Reconnecting...", listOf("100.70.1.2"), 8780)
        assertTrue(text.startsWith("This phone is shared as a drive\nConnected\n"))
        assertTrue(text.contains("http://100.70.1.2:8780/"))
        val waiting = PhoneShareLifecycle.bannerText("This phone is shared as a drive", "Connected", "Reconnecting...", emptyList(), 8780)
        assertEquals("This phone is shared as a drive\nReconnecting...", waiting)
        assertFalse(waiting.contains("http://"))
    }

    @Test fun discoveryRoundTrip() {
        val message = PhoneShareLifecycle.discoveryMessage("abcdef0123456789", 8780)
        val parsed = PhoneShareLifecycle.parseDiscovery(message)
        assertEquals("abcdef0123456789", parsed!!.peerId)
        assertEquals(8780, parsed.port)
        assertNull(PhoneShareLifecycle.parseDiscovery("DRIVEBAY? "))
        assertNull(PhoneShareLifecycle.parseDiscovery("nope"))
    }
}

class DownloadOpenTest {
    @Test fun settingTypeAfterDataDropsTheUri() {
        val lost = IntentSlots().apply {
            assignData("content://media/external/downloads/12")
            assignType("application/pdf")
        }
        assertNull(lost.data)
        val kept = DownloadOpen.launchSlots("content://media/external/downloads/12", "application/pdf")
        assertEquals("content://media/external/downloads/12", kept.data)
        assertEquals("application/pdf", kept.type)
    }

    @Test fun mimeFollowsTheFileWhenTheServerSaysOctetStream() {
        assertEquals("application/pdf", DownloadOpen.mimeType("report.PDF", null))
        assertEquals("application/pdf", DownloadOpen.mimeType("report.pdf", "application/octet-stream"))
        assertEquals("image/png", DownloadOpen.mimeType("photo.bin", "image/png"))
        assertEquals("application/octet-stream", DownloadOpen.mimeType("blob", "application/octet-stream"))
    }

    @Test fun openChooserUsesAFileProviderUri() {
        assertEquals(DownloadOpen.Step.CHOOSER, DownloadOpen.step(1))
        assertEquals(DownloadOpen.Step.TOAST, DownloadOpen.step(0))
        assertEquals("No app can open this file", DownloadOpen.NO_APP)
        val authority = DownloadOpen.authority("com.mesaandmoon.drivebay")
        assertEquals("com.mesaandmoon.drivebay.fileprovider", authority)
        assertTrue(DownloadOpen.isFileProviderUri("content://$authority/open/photo.jpg", "com.mesaandmoon.drivebay"))
        assertFalse(DownloadOpen.isFileProviderUri("content://media/external/downloads/12", "com.mesaandmoon.drivebay"))
        val cache = DownloadOpen.cacheFileName("../Camera/a.pdf", "content://media/external/downloads/12")
        assertTrue(cache.endsWith(".pdf"))
        assertFalse(cache.contains("/"))
        assertFalse(cache.contains(".."))
    }
}

class PhoneDavRestartTest {
    @Test fun sameTokenWorksAfterRestartAndABusyPortThrows() {
        val store = MemoryDavStore()
        assertTrue(store.mkcol("/Camera"))
        val token = PhoneShareAuth.generateToken()
        val hash = PhoneShareAuth.hash(token)
        val peer = PhoneShareLifecycle.peerId(hash)
        val first = PhoneDavServer(store, hash, 0, listOf("127.0.0.1"), peer)
        first.start()
        val port = first.port()
        val options = http(port, "OPTIONS / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        assertTrue(options.startsWith("HTTP/1.1 200"))
        assertTrue(options.contains("X-Drivebay-Phone: $peer"))
        // A second instance must take the port from the first instead of failing EADDRINUSE.
        val busy = PhoneDavServer(store, hash, port, listOf("127.0.0.1"), peer)
        busy.start()
        val taken = http(port, "OPTIONS / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        assertTrue(taken.startsWith("HTTP/1.1 200"))
        first.stop()
        busy.stop()
        val second = PhoneDavServer(store, hash, port, listOf("127.0.0.1"), peer)
        var restarted = false
        var tries = 0
        while (tries < 8 && !restarted) {
            try {
                second.start()
                restarted = true
            } catch (_: java.net.BindException) {
                Thread.sleep(40)
            }
            tries++
        }
        assertTrue("share should bind again on the same port", restarted)
        val header = PhoneShareAuth.basicHeader(PhoneShareAuth.USER, token)
        val listing = http(
            second.port(),
            "PROPFIND / HTTP/1.1\r\nHost: 127.0.0.1\r\nDepth: 1\r\nAuthorization: $header\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        assertTrue(listing.startsWith("HTTP/1.1 207"))
        assertTrue(listing.contains("/Camera"))
        second.stop()
        try {
            PhoneDavServer(store, hash, 0, listOf("8.8.8.8"), peer).start()
            fail("a public address is not a place to share")
        } catch (_: java.net.BindException) {
        }
    }

    private fun http(port: Int, request: String): String {
        val socket = Socket()
        socket.connect(InetSocketAddress("127.0.0.1", port), 2000)
        socket.soTimeout = 2000
        socket.use {
            it.getOutputStream().write(request.toByteArray(Charsets.ISO_8859_1))
            it.getOutputStream().flush()
            return it.getInputStream().readBytes().toString(Charsets.ISO_8859_1)
        }
    }
}
