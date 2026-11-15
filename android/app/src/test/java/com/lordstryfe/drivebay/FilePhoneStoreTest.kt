package com.lordstryfe.drivebay

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** Whole-phone (All files access) mode served through java.io.File. No device needed. */
class FilePhoneStoreTest {
    private lateinit var root: File
    private var access = true
    private lateinit var store: FilePhoneStore
    private val token = PhoneShareAuth.generateToken()
    private val hash = PhoneShareAuth.hash(token)
    private val auth = PhoneShareAuth.basicHeader(PhoneShareAuth.USER, token)

    @Before fun setUp() {
        root = Files.createTempDirectory("drivebay-phone").toFile()
        File(root, "Download").mkdirs()
        File(root, "Download/report.pdf").writeText("pdf")
        File(root, "DCIM/Camera").mkdirs()
        File(root, "Android/data/com.other").mkdirs()
        File(root, "Android/obb").mkdirs()
        File(root, "Android/media").mkdirs()
        File(root, "notes.txt").writeText("root file")
        access = true
        store = FilePhoneStore(root) { access }
    }

    @After fun tearDown() {
        root.deleteRecursively()
    }

    private fun dav(method: String, path: String, headers: Map<String, String> = emptyMap(), body: ByteArray = ByteArray(0)) =
        DavProtocol.handle(DavRequest(method, path, headers + ("Authorization" to auth), body, "100.70.170.22"), store, hash)

    @Test fun rootAndDownloadAreListed() {
        val names = store.list("/")!!.map { it.name }
        assertTrue(names.containsAll(listOf("Download", "DCIM", "Android", "notes.txt")))
        val res = dav("PROPFIND", "/", mapOf("Depth" to "1"))
        assertEquals(207, res.status)
        val xml = String(res.body)
        assertTrue(xml.contains("<d:href>/Download/</d:href>"))
        assertTrue(xml.contains("<d:href>/notes.txt</d:href>"))
        val dl = String(dav("PROPFIND", "/Download", mapOf("Depth" to "1")).body)
        assertTrue(dl.contains("/Download/report.pdf"))
    }

    @Test fun getPutMkcolMoveDelete() {
        val got = dav("GET", "/Download/report.pdf")
        assertEquals(200, got.status)
        assertEquals("pdf", String(got.body))
        assertEquals("3", got.headers["Content-Length"])
        assertEquals(405, dav("GET", "/Download").status)
        assertEquals(404, dav("GET", "/Download/missing").status)

        assertEquals(201, dav("PUT", "/Download/new%20file.txt", body = "hello".toByteArray()).status)
        assertEquals("hello", File(root, "Download/new file.txt").readText())
        assertEquals(201, dav("PUT", "/Download/new%20file.txt", body = "v2".toByteArray()).status)
        assertEquals("v2", File(root, "Download/new file.txt").readText())
        assertFalse(File(root, "Download/.new file.txt.drivebay-part").exists())
        assertEquals(201, dav("PUT", "/top.txt", body = "t".toByteArray()).status) // root writes are allowed
        assertEquals(409, dav("PUT", "/nope/x.txt", body = "x".toByteArray()).status)
        assertEquals(409, dav("PUT", "/Download", body = "x".toByteArray()).status)

        assertEquals(201, dav("MKCOL", "/Download/Stuff").status)
        assertTrue(File(root, "Download/Stuff").isDirectory)
        assertEquals(409, dav("MKCOL", "/Download/Stuff").status)
        assertEquals(409, dav("MKCOL", "/a/b/c").status)

        val moved = dav("MOVE", "/Download/new%20file.txt", mapOf("Destination" to "http://100.70.170.22:8780/Download/Stuff/renamed.txt"))
        assertEquals(201, moved.status)
        assertFalse(File(root, "Download/new file.txt").exists())
        assertEquals("v2", File(root, "Download/Stuff/renamed.txt").readText())
        assertEquals(404, dav("MOVE", "/Download/gone.txt", mapOf("Destination" to "http://h/Download/x.txt")).status)
        assertEquals(400, dav("MOVE", "/Download/Stuff/renamed.txt").status)

        assertEquals(204, dav("DELETE", "/Download/Stuff").status)
        assertFalse(File(root, "Download/Stuff").exists())
        assertEquals(404, dav("DELETE", "/Download/Stuff").status)
    }

    @Test fun binaryRoundTrip() {
        val bytes = ByteArray(300_000) { (it * 31).toByte() }
        assertTrue(store.put("/DCIM/Camera/img.bin", bytes))
        assertArrayEquals(bytes, store.read("/DCIM/Camera/img.bin"))
        assertEquals(300_000L, store.stat("/DCIM/Camera/img.bin")!!.size)
    }

    @Test fun androidDataAndObbAreHiddenAndRefused() {
        val android = store.list("/Android")!!.map { it.name }
        assertEquals(listOf("media"), android)
        assertNull(store.stat("/Android/data"))
        assertNull(store.list("/android/DATA/com.other"))
        assertEquals(404, dav("PROPFIND", "/Android/obb", mapOf("Depth" to "0")).status)
        assertEquals(409, dav("PUT", "/Android/data/x.txt", body = "x".toByteArray()).status)
        assertEquals(409, dav("MKCOL", "/Android/obb/new").status)
        assertEquals(404, dav("DELETE", "/Android/data/com.other").status)
        assertTrue(File(root, "Android/data/com.other").exists())
        assertFalse(store.move("/notes.txt", "/Android/data/notes.txt"))
    }

    @Test fun rootAndStandardFoldersCantBeRemoved() {
        assertEquals(404, dav("DELETE", "/").status)
        assertEquals(404, dav("DELETE", "/Download").status)
        assertEquals(404, dav("DELETE", "/dcim").status)
        assertTrue(File(root, "Download").isDirectory)
        assertFalse(store.move("/Download", "/Download2"))
        assertFalse(store.move("/DCIM", "/DCIM/Camera/x"))
        assertEquals(204, dav("DELETE", "/notes.txt").status) // ordinary root files can go
    }

    @Test fun pathsCantEscapeStorage() {
        assertEquals(400, dav("GET", "/Download/../../etc/passwd").status)
        assertEquals(400, dav("GET", "/%2e%2e/x").status)
        assertNull(store.resolve("/a\\..\\b"))
        val outside = Files.createTempDirectory("drivebay-outside").toFile()
        try {
            File(outside, "secret.txt").writeText("nope")
            val link = File(root, "link")
            val linked = runCatching { Files.createSymbolicLink(link.toPath(), outside.toPath()) }.isSuccess
            if (linked) {
                assertNull(store.read("/link/secret.txt"))
                assertFalse(store.put("/link/evil.txt", "x".toByteArray()))
                assertFalse(File(outside, "evil.txt").exists())
            }
        } finally {
            outside.deleteRecursively()
        }
    }

    @Test fun revokedAccessFailsCleanly() {
        access = false
        assertFalse(store.usable())
        assertNull(store.list("/"))
        assertNull(store.stat("/"))
        assertNull(store.read("/notes.txt"))
        assertFalse(store.put("/x.txt", "x".toByteArray()))
        assertFalse(store.mkcol("/new"))
        assertFalse(store.delete("/notes.txt"))
        assertFalse(store.move("/notes.txt", "/n2.txt"))
        assertEquals(404, dav("PROPFIND", "/", mapOf("Depth" to "1")).status)
        assertEquals(404, dav("GET", "/notes.txt").status)
        assertTrue(File(root, "notes.txt").exists())
        // A throwing permission check is also treated as no access.
        val throwing = FilePhoneStore(root) { throw SecurityException("revoked") }
        assertFalse(throwing.usable())
        assertNull(throwing.list("/"))
        access = true
        assertEquals(207, dav("PROPFIND", "/", mapOf("Depth" to "0")).status)
    }

    @Test fun authStillRequired() {
        val noAuth = DavProtocol.handle(DavRequest("PROPFIND", "/", mapOf("Depth" to "1"), remoteAddress = "100.70.170.22"), store, hash)
        assertEquals(401, noAuth.status)
        val wrong = DavProtocol.handle(
            DavRequest("GET", "/notes.txt", mapOf("Authorization" to PhoneShareAuth.basicHeader(PhoneShareAuth.USER, "123456")), remoteAddress = "192.168.1.5"),
            store,
            hash,
        )
        assertEquals(401, wrong.status)
    }

    @Test fun blockedHelpers() {
        assertTrue(FilePhoneStore.blocked("/Android/data"))
        assertTrue(FilePhoneStore.blocked("/Android/OBB/x"))
        assertFalse(FilePhoneStore.blocked("/Android/media"))
        assertFalse(FilePhoneStore.blocked("/Android/database"))
        assertTrue(FilePhoneStore.isProtectedTopLevel("/Download"))
        assertFalse(FilePhoneStore.isProtectedTopLevel("/Download/a"))
        assertFalse(FilePhoneStore.isProtectedTopLevel("/MyStuff"))
    }
}
