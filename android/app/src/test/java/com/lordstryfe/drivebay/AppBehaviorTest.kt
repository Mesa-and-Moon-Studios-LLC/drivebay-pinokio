package com.lordstryfe.drivebay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

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

    private var stored: String = ""
}
