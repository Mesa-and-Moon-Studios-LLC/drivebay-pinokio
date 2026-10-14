package com.lordstryfe.drivebay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerAddressTest {
    @Test
    fun suggestedPortAndLegacyRange() {
        assertEquals(8765, ServerAddress.SUGGESTED_PORT)
        assertEquals(8766, ServerAddress.ALSO_COMMON_PORT)
        assertTrue(ServerAddress.isLegacyPort(42000))
        assertTrue(ServerAddress.isLegacyPort(42018))
        assertTrue(ServerAddress.isLegacyPort(42999))
        assertFalse(ServerAddress.isLegacyPort(8765))
        assertFalse(ServerAddress.isLegacyPort(8766))
        assertFalse(ServerAddress.isLegacyPort(41999))
    }

    @Test
    fun homeUrlDropsThePathAndKeepsThePort() {
        assertEquals("http://100.1.2.3:8765/", ServerAddress.homeUrl("100.1.2.3:8765/settings?next=1"))
        assertEquals("https://pc.tailnet.ts.net:8766/", ServerAddress.homeUrl("https://pc.tailnet.ts.net:8766/files"))
        assertEquals(42018, ServerAddress.portOf("http://100.80.180.121:42018"))
        assertEquals("100.1.2.3", ServerAddress.hostOf("http://100.1.2.3:8765/api/download?path=a"))
        assertNull(ServerAddress.portOf("http://pc.tailnet.ts.net"))
        assertEquals("http://100.1.2.3:8765/", ServerAddress.withPort("http://100.1.2.3:42018/folder", 8765))
    }

    @Test
    fun adminSettingsStayOutOfTheApp() {
        assertTrue(ServerAddress.isAdminSettingsPath("/settings"))
        assertTrue(ServerAddress.isAdminSettingsPath("/settings/"))
        assertTrue(ServerAddress.isAdminSettingsUrl("http://100.1.2.3:8765/settings?next=1"))
        assertFalse(ServerAddress.isAdminSettingsPath("/"))
        assertFalse(ServerAddress.isAdminSettingsPath("/login"))
        assertFalse(ServerAddress.isAdminSettingsUrl("http://100.1.2.3:8765/"))
    }

    @Test
    fun fileNamesStayInsideOnePathSegment() {
        val url = "http://pc:8765/api/download?path=C%3A%5CUsers%5CAaron%5Cvacation%20photo.jpg"
        assertEquals("vacation photo.jpg", DownloadNames.fileNameFromDownloadUrl(url, ""))
        assertEquals("notes.txt", DownloadNames.fileNameFromDownloadUrl(url, "notes.txt"))
        assertEquals("a_b", DownloadNames.safeFileName("../a/b"))
        assertEquals("download", DownloadNames.safeFileName("   "))
    }
}
