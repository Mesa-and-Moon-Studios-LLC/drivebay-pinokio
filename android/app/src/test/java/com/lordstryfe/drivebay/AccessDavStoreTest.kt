package com.lordstryfe.drivebay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccessDavStoreTest {
    @Test fun readOnlyFolderRejectsWrites() {
        val inner = MemoryDav()
        val store = AccessDavStore(inner) { path ->
            AccessDavStore.folderWritable(path) { name -> if (name == "Photos") "ro" else "rw" }
        }
        assertEquals(1, store.list("/")?.size)
        assertTrue(store.read("/Photos/cat.txt")!!.isNotEmpty())
        assertFalse(store.put("/Photos/new.txt", "no".toByteArray()))
        assertFalse(store.delete("/Photos/cat.txt"))
        assertTrue(store.put("/Docs/new.txt", "yes".toByteArray()))
        assertEquals("yes", inner.files["/Docs/new.txt"])
    }

    private class MemoryDav : DavStore {
        val files = mutableMapOf("/Photos/cat.txt" to "cat", "/Docs/note.txt" to "note")

        override fun list(path: String): List<DavNode> = listOf(DavNode("/Photos", "Photos", true, 0, 0))

        override fun stat(path: String): DavNode? = DavNode(path, path.substringAfterLast('/'), false, 1, 0)

        override fun read(path: String): ByteArray? = files[path]?.toByteArray()

        override fun put(path: String, bytes: ByteArray): Boolean {
            files[path] = bytes.toString(Charsets.UTF_8)
            return true
        }

        override fun delete(path: String): Boolean = files.remove(path) != null

        override fun mkcol(path: String): Boolean = true

        override fun move(from: String, to: String): Boolean = false
    }
}
