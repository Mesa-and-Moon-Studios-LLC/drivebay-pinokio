package com.lordstryfe.drivebay

/**
 * WebDAV wrapper that refuses writes unless the shared folder is read-write.
 * Listing and downloads still work for a read-only folder.
 */
class AccessDavStore(
    private val inner: DavStore,
    private val writable: (path: String) -> Boolean,
) : DavStore {
    override fun list(path: String): List<DavNode>? = inner.list(path)

    override fun stat(path: String): DavNode? = inner.stat(path)

    override fun read(path: String): ByteArray? = inner.read(path)

    override fun put(path: String, bytes: ByteArray): Boolean = writable(path) && inner.put(path, bytes)

    override fun delete(path: String): Boolean = writable(path) && inner.delete(path)

    override fun mkcol(path: String): Boolean = writable(path) && inner.mkcol(path)

    override fun move(from: String, to: String): Boolean = writable(from) && writable(to) && inner.move(from, to)

    companion object {
        fun folderWritable(path: String, accessOf: (name: String) -> String): Boolean {
            val top = path.trim('/').substringBefore('/')
            if (top.isEmpty()) return false
            return accessOf(top) == "rw"
        }
    }
}
