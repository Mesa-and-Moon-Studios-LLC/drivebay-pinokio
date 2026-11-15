package com.lordstryfe.drivebay

import java.io.File

/**
 * WebDAV view of the whole phone storage (/storage/emulated/0) through java.io.File.
 * Used only when the user opted in to "Share whole phone storage" and Android granted
 * All files access. Pure JVM so unit tests run it against a temp folder.
 *
 * [hasAccess] is checked on every call: if the permission is revoked while sharing,
 * every request fails cleanly (404/409) instead of throwing.
 * Android/data and Android/obb are hidden and refused: apps can't use them on Android 11+.
 */
class FilePhoneStore(
    root: File,
    private val hasAccess: () -> Boolean = { true },
) : DavStore {
    private val rootDir: File = runCatching { root.toPath().toRealPath().toFile() }.getOrElse { root.canonicalFile }

    fun usable(): Boolean = runCatching { hasAccess() && rootDir.isDirectory && rootDir.canRead() }.getOrDefault(false)

    override fun list(path: String): List<DavNode>? = guard(null) {
        val dir = resolve(path) ?: return@guard null
        if (!dir.isDirectory) return@guard null
        val children = dir.listFiles() ?: return@guard emptyList()
        val base = path.trimEnd('/')
        children.sortedBy { it.name.lowercase() }.mapNotNull { child ->
            val childPath = "$base/${child.name}"
            if (blocked(childPath)) null else toNode(childPath, child)
        }
    }

    override fun stat(path: String): DavNode? = guard(null) {
        if (path == "/") return@guard if (usable()) DavNode("/", "Phone storage", true, 0, rootDir.lastModified()) else null
        val file = resolve(path) ?: return@guard null
        if (!file.exists()) null else toNode(path, file)
    }

    override fun read(path: String): ByteArray? = guard(null) {
        val file = resolve(path) ?: return@guard null
        if (!file.isFile) null else file.readBytes()
    }

    override fun put(path: String, bytes: ByteArray): Boolean = guard(false) {
        if (path == "/") return@guard false
        val file = resolve(path) ?: return@guard false
        if (file.isDirectory) return@guard false
        val parent = file.parentFile ?: return@guard false
        if (!parent.isDirectory) return@guard false
        // Write to a temp file then swap in, so a dropped upload doesn't truncate the old file.
        val tmp = File(parent, ".${file.name}.drivebay-part")
        tmp.writeBytes(bytes)
        if (file.exists() && !file.delete()) {
            tmp.delete(); return@guard false
        }
        if (!tmp.renameTo(file)) {
            tmp.delete(); return@guard false
        }
        true
    }

    override fun delete(path: String): Boolean = guard(false) {
        if (path == "/" || isProtectedTopLevel(path)) return@guard false
        val file = resolve(path) ?: return@guard false
        if (!file.exists()) return@guard false
        file.deleteRecursively()
    }

    override fun mkcol(path: String): Boolean = guard(false) {
        if (path == "/") return@guard false
        val file = resolve(path) ?: return@guard false
        if (file.exists()) return@guard false
        val parent = file.parentFile ?: return@guard false
        parent.isDirectory && file.mkdir()
    }

    override fun move(from: String, to: String): Boolean = guard(false) {
        if (from == "/" || to == "/" || isProtectedTopLevel(from)) return@guard false
        if (to == from || to.startsWith("$from/")) return@guard false
        val src = resolve(from) ?: return@guard false
        val dst = resolve(to) ?: return@guard false
        if (!src.exists()) return@guard false
        val parent = dst.parentFile ?: return@guard false
        if (!parent.isDirectory) return@guard false
        if (dst.exists()) {
            if (dst.isDirectory || src.isDirectory) return@guard false
            if (!dst.delete()) return@guard false
        }
        if (src.renameTo(dst)) return@guard true
        // Rename can fail across mount points; copy then remove.
        if (src.isDirectory) {
            src.copyRecursively(dst, overwrite = false) && src.deleteRecursively()
        } else {
            src.copyTo(dst, overwrite = true); src.delete()
            true
        }
    }

    /** Maps a normalized DAV path to a file under the root, or null when it escapes or is blocked. */
    internal fun resolve(path: String): File? {
        if (!usable()) return null
        if (blocked(path)) return null
        val parts = path.split('/').filter { it.isNotEmpty() }
        if (parts.any { it == "." || it == ".." || it.contains('\u0000') || it.contains('\\') }) return null
        var file = rootDir
        for (p in parts) file = File(file, p)
        // Symlinks must not lead outside the shared storage: resolve the deepest part that exists.
        var existing: File? = file
        while (existing != null && !existing.exists()) existing = existing.parentFile
        val real = runCatching { existing?.toPath()?.toRealPath()?.toFile() }.getOrNull() ?: return null
        if (real != rootDir && !real.path.startsWith(rootDir.path + File.separator)) return null
        return file
    }

    private fun toNode(path: String, file: File): DavNode =
        DavNode(path, file.name, file.isDirectory, if (file.isFile) file.length() else 0, file.lastModified())

    private inline fun <T> guard(fallback: T, block: () -> T): T = try {
        if (!usable()) fallback else block()
    } catch (_: SecurityException) {
        fallback
    } catch (_: java.io.IOException) {
        fallback
    }

    companion object {
        private val BLOCKED = listOf("/android/data", "/android/obb")
        private val PROTECTED_TOP = setOf(
            "android", "dcim", "download", "documents", "pictures", "music", "movies",
            "alarms", "notifications", "podcasts", "ringtones", "recordings", "audiobooks",
        )

        /** Android/data and Android/obb (any case) and everything under them. */
        fun blocked(path: String): Boolean {
            val lower = path.lowercase()
            return BLOCKED.any { lower == it || lower.startsWith("$it/") }
        }

        /** Standard top-level folders can't be deleted or moved from the PC, only their contents. */
        fun isProtectedTopLevel(path: String): Boolean {
            val parts = path.split('/').filter { it.isNotEmpty() }
            return parts.size == 1 && parts[0].lowercase() in PROTECTED_TOP
        }
    }
}
