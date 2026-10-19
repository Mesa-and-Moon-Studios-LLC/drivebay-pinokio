package com.lordstryfe.drivebay

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

data class SharedFolder(val uri: String, val name: String)

/** Folder names for the tree URIs the system folder picker returns. Pure, so JVM tests cover it. */
object PhoneShareNames {
    /**
     * Name from a tree document id such as "primary:DCIM/Camera" or "1234-ABCD:Download".
     * The storage root itself ("primary:") becomes "Phone storage".
     */
    fun fromTreeDocumentId(documentId: String?): String {
        if (documentId.isNullOrBlank()) return "Folder"
        val path = documentId.substringAfter(':', documentId).trimEnd('/')
        if (path.isBlank()) return if (documentId.startsWith("primary")) "Phone storage" else "SD card"
        return clean(path.substringAfterLast('/'))
    }

    /** WebDAV top-level names must be unique and must not contain a slash. */
    fun clean(raw: String): String {
        val name = raw.replace('/', '_').replace('\\', '_').trim()
        return if (name.isEmpty() || name == "." || name == "..") "Folder" else name
    }

    fun unique(name: String, taken: Collection<String>): String {
        if (name !in taken) return name
        var n = 2
        while ("$name ($n)" in taken) n++
        return "$name ($n)"
    }
}

class PhoneShareStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun enabled(): Boolean = prefs.getBoolean(KEY_ENABLED, false)

    fun setEnabled(value: Boolean) {
        prefs.edit().putBoolean(KEY_ENABLED, value).apply()
    }

    fun tokenHash(): String? = prefs.getString(KEY_HASH, null)?.takeIf { it.length == 64 }

    fun setTokenHash(hash: String) {
        prefs.edit().putString(KEY_HASH, hash).apply()
    }

    fun folders(): List<SharedFolder> {
        val raw = prefs.getString(KEY_FOLDERS, null) ?: return emptyList()
        return try {
            val array = JSONArray(raw)
            buildList {
                for (i in 0 until array.length()) {
                    val obj = array.getJSONObject(i)
                    val uri = obj.optString("uri")
                    val name = obj.optString("name")
                    if (uri.isNotBlank() && name.isNotBlank()) add(SharedFolder(uri, name))
                }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun setFolders(folders: List<SharedFolder>) {
        val array = JSONArray()
        folders.forEach { array.put(JSONObject().put("uri", it.uri).put("name", it.name)) }
        prefs.edit().putString(KEY_FOLDERS, array.toString()).apply()
    }

    companion object {
        private const val PREFS = "drivebay_phone_share"
        const val KEY_ENABLED = "enabled"
        private const val KEY_HASH = "token_hash"
        private const val KEY_FOLDERS = "folders"
    }
}

/** WebDAV view of the folders the user picked with the system document picker. */
class DocumentPhoneStore(
    private val context: Context,
    folders: List<SharedFolder>,
) : DavStore {
    private val roots: List<Pair<String, DocumentFile>> = folders.mapNotNull { folder ->
        // A folder whose access was revoked (or that was deleted) is skipped, not fatal.
        try {
            val doc = DocumentFile.fromTreeUri(context, Uri.parse(folder.uri)) ?: return@mapNotNull null
            if (!doc.isDirectory) return@mapNotNull null
            folder.name to doc
        } catch (_: Exception) {
            null
        }
    }

    fun rootCount(): Int = roots.size

    override fun list(path: String): List<DavNode>? {
        if (path == "/") return roots.map { (name, _) -> DavNode("/$name", name, true, 0, 0) }
        val node = resolve(path) ?: return null
        if (!node.isDirectory) return emptyList()
        return node.listFiles().mapNotNull { child -> toNode(path.trimEnd('/') + "/" + (child.name ?: return@mapNotNull null), child) }
    }

    override fun stat(path: String): DavNode? {
        if (path == "/") return DavNode("/", "Drivebay", true, 0, 0)
        val node = resolve(path) ?: return null
        return toNode(path, node)
    }

    override fun read(path: String): ByteArray? {
        val node = resolve(path) ?: return null
        if (!node.isFile) return null
        val input = context.contentResolver.openInputStream(node.uri) ?: return null
        return input.use { stream ->
            val out = ByteArrayOutputStream()
            stream.copyTo(out)
            out.toByteArray()
        }
    }

    override fun put(path: String, bytes: ByteArray): Boolean {
        val parentPath = path.substringBeforeLast('/', "/")
        val name = path.substringAfterLast('/')
        if (name.isBlank() || name == "." || name == "..") return false
        val parent = if (parentPath == "/") return false else resolve(parentPath) ?: return false
        if (!parent.isDirectory) return false
        val existing = parent.findFile(name)
        val target = existing ?: parent.createFile("application/octet-stream", name) ?: return false
        val out = context.contentResolver.openOutputStream(target.uri, "wt") ?: return false
        out.use { it.write(bytes) }
        return true
    }

    override fun delete(path: String): Boolean {
        if (path == "/" || !path.drop(1).contains('/')) return false
        return resolve(path)?.delete() == true
    }

    override fun mkcol(path: String): Boolean {
        val parentPath = path.substringBeforeLast('/', "/")
        val name = path.substringAfterLast('/')
        if (parentPath == "/" || name.isBlank()) return false
        val parent = resolve(parentPath) ?: return false
        if (parent.findFile(name) != null) return false
        return parent.createDirectory(name) != null
    }

    override fun move(from: String, to: String): Boolean {
        val bytes = read(from) ?: return false
        if (!put(to, bytes)) return false
        delete(from)
        return true
    }

    private fun resolve(path: String): DocumentFile? {
        val parts = path.split('/').filter { it.isNotEmpty() }
        if (parts.isEmpty()) return null
        var current = roots.firstOrNull { it.first == parts[0] }?.second ?: return null
        for (part in parts.drop(1)) {
            current = current.findFile(part) ?: return null
        }
        return current
    }

    private fun toNode(path: String, file: DocumentFile): DavNode? {
        val name = file.name ?: return null
        return DavNode(path, name, file.isDirectory, if (file.isFile) file.length() else 0, file.lastModified())
    }
}
