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

class PhoneShareStore(context: Context) : PhoneShareCodeState, PhonePairDirectory {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val pairLock = Any()

    fun enabled(): Boolean = prefs.getBoolean(KEY_ENABLED, false)

    /** Turning sharing off also clears the 6-digit code. */
    fun setEnabled(value: Boolean) {
        val edit = prefs.edit().putBoolean(KEY_ENABLED, value)
        if (!value) edit.remove(KEY_CODE).remove(KEY_CODE_FAILURES)
        edit.commit()
    }

    override fun codeRecord(): String? = prefs.getString(KEY_CODE, null)

    override fun codeFailures(): Int = prefs.getInt(KEY_CODE_FAILURES, 0)

    override fun saveCodeFailures(count: Int) {
        prefs.edit().putInt(KEY_CODE_FAILURES, count).commit()
    }

    override fun saveCode(record: String?, failures: Int) {
        val edit = prefs.edit().putInt(KEY_CODE_FAILURES, failures)
        if (record == null) edit.remove(KEY_CODE) else edit.putString(KEY_CODE, record)
        edit.commit()
    }

    fun codeLocked(): Boolean {
        val list = pairs()
        if (list.isNotEmpty() || prefs.contains(KEY_PAIRS)) {
            return list.any { it.codeRecord != null && it.codeFailures >= PhoneShareCode.MAX_FAILURES }
        }
        return codeRecord() != null && codeFailures() >= PhoneShareCode.MAX_FAILURES
    }

    /** New token: new code hash and a fresh strike count. The plain token and code are never stored. */
    fun setCredentials(tokenHash: String, codeRecord: String) {
        prefs.edit()
            .putString(KEY_HASH, tokenHash)
            .putString(KEY_CODE, codeRecord)
            .putInt(KEY_CODE_FAILURES, 0)
            .commit()
    }

    fun ownerRecord(): String? = prefs.getString(KEY_OWNER, null)?.takeIf { it.startsWith("pbkdf2-sha256$") }

    fun setOwnerRecord(record: String) {
        prefs.edit().putString(KEY_OWNER, record).commit()
    }

    /** Paired PCs. A single token from an older install is saved as the first entry the first time this is read. */
    fun pairs(): List<PhonePair> = snapshot()

    override fun snapshot(): List<PhonePair> = synchronized(pairLock) { loadPairs() }

    override fun save(pairs: List<PhonePair>) {
        synchronized(pairLock) { writePairs(pairs) }
    }

    override fun noteSeen(id: String, now: Long) {
        synchronized(pairLock) {
            val current = loadPairs()
            if (current.none { it.id == id }) return
            val next = PhonePairRules.touch(current, id, now)
            if (next !== current) writePairs(next)
        }
    }

    override fun recordCodeMiss() {
        synchronized(pairLock) { writePairs(PhonePairRules.noteCodeMiss(loadPairs())) }
    }

    override fun noteHostName(id: String, hostName: String, now: Long): Boolean {
        synchronized(pairLock) {
            val next = PhonePairRules.applyHostName(loadPairs(), id, hostName, now) ?: return false
            writePairs(next)
            return true
        }
    }

    fun rename(id: String, name: String): Boolean = synchronized(pairLock) {
        val next = PhonePairRules.rename(loadPairs(), id, name) ?: return false
        writePairs(next)
        true
    }

    private fun loadPairs(): List<PhonePair> {
        if (prefs.contains(KEY_PAIRS)) return PhonePairJson.decode(prefs.getString(KEY_PAIRS, null))
        val legacy = legacyTokenHash() ?: return emptyList()
        val migrated = PhonePairRules.migrate(emptyList(), legacy, prefs.getString(KEY_CODE, null), prefs.getInt(KEY_CODE_FAILURES, 0))
        if (migrated.isNotEmpty()) writePairs(migrated)
        return migrated
    }

    private fun writePairs(pairs: List<PhonePair>) {
        val edit = prefs.edit().putString(KEY_PAIRS, PhonePairJson.encode(pairs))
        val legacy = legacyTokenHash()
        if (legacy != null && pairs.none { it.tokenHash == legacy }) {
            edit.remove(KEY_HASH).remove(KEY_CODE).remove(KEY_CODE_FAILURES)
        }
        edit.commit()
    }

    /** Adds one PC. Hashes only: the caller passes SHA-256 of the token and PBKDF2 of the code. */
    fun addPair(name: String, tokenHash: String, codeRecord: String): PhonePair = synchronized(pairLock) {
        val stored = PhonePairRules.storedName(name)
        val pair = PhonePair(
            id = tokenHash,
            name = stored,
            tokenHash = tokenHash,
            codeRecord = codeRecord.takeIf { it.startsWith("pbkdf2-sha256$") },
            codeFailures = 0,
            lastSeenMs = 0,
            customName = stored.isNotEmpty(),
        )
        val next = PhonePairRules.append(loadPairs(), pair)
        val edit = prefs.edit().putString(KEY_PAIRS, PhonePairJson.encode(next))
        if (legacyTokenHash() == null) {
            edit.putString(KEY_HASH, tokenHash).putString(KEY_CODE, codeRecord).putInt(KEY_CODE_FAILURES, 0)
        }
        edit.commit()
        pair
    }

    /** Drops that PC's token. The next WebDAV request from it fails. */
    fun revoke(id: String) {
        synchronized(pairLock) { writePairs(PhonePairRules.revoke(loadPairs(), id)) }
    }

    fun tokenHash(): String? {
        if (prefs.contains(KEY_PAIRS)) {
            return PhonePairJson.decode(prefs.getString(KEY_PAIRS, null)).firstOrNull()?.tokenHash?.takeIf { it.length == 64 }
        }
        return legacyTokenHash()
    }

    private fun legacyTokenHash(): String? = prefs.getString(KEY_HASH, null)?.takeIf { it.length == 64 }

    fun setTokenHash(hash: String) {
        prefs.edit().putString(KEY_HASH, hash).apply()
    }

    /** Opt-in whole-phone mode (All files access). Off by default; picked folders stay the default. */
    fun wholePhone(): Boolean = prefs.getBoolean(KEY_WHOLE_PHONE, false)

    fun setWholePhone(value: Boolean) {
        prefs.edit().putBoolean(KEY_WHOLE_PHONE, value).commit()
    }

    /** Something to share: whole phone mode or at least one picked folder. */
    fun hasShareSource(): Boolean = wholePhone() || folders().isNotEmpty()

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
        private const val KEY_CODE = "code_hash"
        private const val KEY_CODE_FAILURES = "code_failures"
        private const val KEY_WHOLE_PHONE = "whole_phone"
        private const val KEY_PAIRS = "pairs"
        private const val KEY_OWNER = "owner_password"
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
