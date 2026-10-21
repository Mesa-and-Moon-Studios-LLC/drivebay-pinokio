package com.lordstryfe.drivebay

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

data class SharedFolder(val uri: String, val name: String)

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

    /** Addresses the WebDAV server is actually listening on. Empty while it is down. */
    fun listeningHosts(): List<String> =
        prefs.getString(KEY_LISTENING, null).orEmpty().split(',').map { it.trim() }.filter { it.isNotEmpty() }

    fun setListening(hosts: List<String>) {
        prefs.edit().putString(KEY_LISTENING, hosts.joinToString(",")).commit()
    }

    companion object {
        private const val PREFS = "drivebay_phone_share"
        const val KEY_ENABLED = "enabled"
        private const val KEY_HASH = "token_hash"
        private const val KEY_FOLDERS = "folders"
        private const val KEY_LISTENING = "listening"
    }
}

/** WebDAV view of the folders the user picked with the system document picker. */
class DocumentPhoneStore(
    private val context: Context,
    folders: List<SharedFolder>,
) : DavStore {
    private val roots: List<Pair<String, DocumentFile>> = folders.mapNotNull { folder ->
        val doc = DocumentFile.fromTreeUri(context, Uri.parse(folder.uri)) ?: return@mapNotNull null
        if (!doc.isDirectory) return@mapNotNull null
        folder.name to doc
    }

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
