package com.lordstryfe.drivebay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.net.BindException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

/** Regression checks for the 3.34.0 crash after choosing a phone-as-drive folder. No device needed. */
class PhoneShareNamesTest {
    @Test fun namesFromTreeDocumentIds() {
        assertEquals("Camera", PhoneShareNames.fromTreeDocumentId("primary:DCIM/Camera"))
        assertEquals("Download", PhoneShareNames.fromTreeDocumentId("primary:Download"))
        assertEquals("Phone storage", PhoneShareNames.fromTreeDocumentId("primary:"))
        assertEquals("SD card", PhoneShareNames.fromTreeDocumentId("1234-ABCD:"))
        assertEquals("Music", PhoneShareNames.fromTreeDocumentId("1234-ABCD:Music/"))
        assertEquals("Folder", PhoneShareNames.fromTreeDocumentId(null))
        assertEquals("Folder", PhoneShareNames.fromTreeDocumentId(""))
    }

    @Test fun namesAreSafeAndUnique() {
        assertEquals("a_b", PhoneShareNames.clean("a/b"))
        assertEquals("Folder", PhoneShareNames.clean(".."))
        assertEquals("Download", PhoneShareNames.unique("Download", listOf("DCIM")))
        assertEquals("Download (2)", PhoneShareNames.unique("Download", listOf("Download")))
        assertEquals("Download (3)", PhoneShareNames.unique("Download", listOf("Download", "Download (2)")))
    }
}

class CrashLogTest {
    @Test fun formatKeepsTraceAndRedactsTokens() {
        val token = "db_" + "ab".repeat(32)
        val text = CrashLog.format(
            title = "Crash on thread main",
            error = IllegalStateException("boom $token"),
            nowMillis = 0L,
            app = "Drivebay 3.34.1 (33401)",
            device = "samsung SM-S938U, Android 16 (SDK 36)",
        )
        assertTrue(text.startsWith("Crash on thread main\nWhen: 1970-01-01 00:00:00 UTC\n"))
        assertTrue(text.contains("Drivebay 3.34.1 (33401)"))
        assertTrue(text.contains("java.lang.IllegalStateException: boom db_[redacted]"))
        assertTrue(text.contains("CrashLogTest"))
        assertFalse(text.contains(token))
    }

    @Test fun formatIsCapped() {
        val deep = RuntimeException("x".repeat(200_000))
        val text = CrashLog.format("t", deep, 0L, "a", "d")
        assertTrue(text.length < 50_000)
    }
}

class PhoneDavServerBindTest {
    private fun freePort(): Int = ServerSocket(0).use { it.localPort }

    @Test fun portInUseThrowsAndLeavesNothingOpen() {
        val port = freePort()
        ServerSocket(port, 50, InetAddress.getByName("127.0.0.1")).use {
            val server = PhoneDavServer(MemoryDavStore(), "0".repeat(64), port, listOf("127.0.0.1"))
            try {
                server.start()
                fail("expected BindException")
            } catch (_: BindException) {
            }
            server.stop()
        }
    }

    @Test fun stopClosesTheSocketAndASecondServerTakesThePort() {
        val first = PhoneDavServer(MemoryDavStore(), "0".repeat(64), 0, listOf("127.0.0.1"))
        first.start()
        val port = first.port()
        val second = PhoneDavServer(MemoryDavStore(), "0".repeat(64), port, listOf("127.0.0.1"))
        second.start()
        try {
            Socket("127.0.0.1", port).use { socket ->
                socket.getOutputStream().write("OPTIONS / HTTP/1.1\r\nHost: x\r\n\r\n".toByteArray())
                val reply = socket.getInputStream().bufferedReader().readLine()
                assertTrue(reply, reply.startsWith("HTTP/1.1 200"))
            }
            first.stop()
            second.stop()
            var freed = false
            var last: Exception? = null
            repeat(10) { n ->
                try {
                    ServerSocket().use { taken ->
                        taken.reuseAddress = true
                        taken.bind(java.net.InetSocketAddress("127.0.0.1", port))
                    }
                    freed = true
                    return@repeat
                } catch (e: BindException) {
                    last = e
                    Thread.sleep(20L * (n + 1))
                }
            }
            if (!freed) throw last ?: BindException("port $port stayed busy after stop")
        } finally {
            first.stop()
            second.stop()
        }
    }

    @Test fun foreignHolderIsAddressInUseUntilItCloses() {
        val port = freePort()
        val holder = ServerSocket()
        holder.reuseAddress = true
        holder.bind(java.net.InetSocketAddress("127.0.0.1", port))
        val server = PhoneDavServer(MemoryDavStore(), "0".repeat(64), port, listOf("127.0.0.1"))
        try {
            server.start()
            fail("expected BindException")
        } catch (e: BindException) {
            assertTrue(e.toString(), PhoneShareLifecycle.isAddressInUse(e))
        } finally {
            holder.close()
        }
        server.start()
        server.stop()
    }

    @Test fun oneBadAddressDoesNotStopTheOthers() {
        val port = freePort()
        // 10.255.255.254 is private but not on this machine, so binding it fails.
        val server = PhoneDavServer(MemoryDavStore(), "0".repeat(64), port, listOf("10.255.255.254", "127.0.0.1"))
        server.start()
        try {
            Socket("127.0.0.1", port).use { socket ->
                socket.getOutputStream().write("OPTIONS / HTTP/1.1\r\nHost: x\r\n\r\n".toByteArray())
                val reply = socket.getInputStream().bufferedReader().readLine()
                assertTrue(reply, reply.startsWith("HTTP/1.1 200"))
            }
        } finally {
            server.stop()
        }
    }
}

/** Static checks of the source and manifest for the Android 14+ foreground-service rules. */
class PhoneShareManifestTest {
    private val manifest = File("src/main/AndroidManifest.xml").readText()
    private val activity = File("src/main/java/com/lordstryfe/drivebay/MainActivity.kt").readText()
    private val service = File("src/main/java/com/lordstryfe/drivebay/PhoneShareService.kt").readText()

    @Test fun serviceKeepsSpecialUseWithSubtypeAndPermissions() {
        val block = manifest.substringAfter("android:name=\".PhoneShareService\"").substringBefore("</service>")
        assertTrue(block.contains("android:foregroundServiceType=\"specialUse|dataSync\""))
        assertTrue(block.contains("android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"))
        assertTrue(manifest.contains("android.permission.FOREGROUND_SERVICE_SPECIAL_USE"))
        assertTrue(manifest.contains("android.permission.FOREGROUND_SERVICE_DATA_SYNC"))
        assertTrue(manifest.contains("android.permission.POST_NOTIFICATIONS"))
        assertTrue(service.contains("FOREGROUND_SERVICE_TYPE_SPECIAL_USE"))
    }

    @Test fun pickedTreeUriIsNeverQueriedDirectly() {
        // 3.34.0 crashed here: contentResolver.query(treeUri) throws "Unsupported Uri".
        assertFalse(activity.contains("DocumentName(uri)"))
        val nameFn = activity.substringAfter("private fun folderName(treeUri: Uri)").substringBefore("private fun showErrorLog")
        assertTrue(nameFn.contains("buildDocumentUriUsingTree"))
        assertFalse(nameFn.contains("query(treeUri"))
    }

    @Test fun reuseAddrIsSetBeforeBindAndPortInUseGivesUp() {
        val dav = File("src/main/java/com/lordstryfe/drivebay/PhoneDavServer.kt").readText()
        val open = dav.substringAfter("private fun open")
        val reuse = open.indexOf("setReuseAddress(true)")
        val bind = open.indexOf(".bind(")
        assertTrue(reuse >= 0 && bind > reuse)
        assertTrue(dav.contains("it.closeSockets()"))
        assertTrue(service.contains("fun onDestroy()"))
        assertTrue(service.contains("running?.stop()"))
        assertTrue(service.contains("isAddressInUse"))
        assertTrue(service.contains("portInUseExhausted"))
        assertTrue(service.contains("phone_share_err_port"))
        assertTrue(service.contains("phone_share_port_retry"))
    }

    @Test fun crashLogIsInstalled() {
        val app = File("src/main/java/com/lordstryfe/drivebay/DrivebayApp.kt").readText()
        assertTrue(app.contains("CrashLog.install(this)"))
    }
}
