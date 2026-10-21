package com.lordstryfe.drivebay

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom

/** One PC that may use the phone share. The token and the 6-digit code are stored only as hashes. */
data class PhonePair(
    val id: String,
    val name: String,
    val tokenHash: String,
    val codeRecord: String?,
    val codeFailures: Int,
    val lastSeenMs: Long,
)

/** Live list of paired PCs. The WebDAV server reads this on every request, so a revoke applies immediately. */
interface PhonePairDirectory {
    fun snapshot(): List<PhonePair>
    fun save(pairs: List<PhonePair>)

    /** Updates last seen only when [id] is still paired. Must not write a list that puts a revoked PC back. */
    fun noteSeen(id: String, now: Long) {
        val current = snapshot()
        if (current.none { it.id == id }) return
        val next = PhonePairRules.touch(current, id, now)
        if (next !== current) save(next)
    }

    /** One strike on every active code, applied to the list as it is now. */
    fun recordCodeMiss() {
        save(PhonePairRules.noteCodeMiss(snapshot()))
    }
}

class MemoryPairDirectory(pairs: List<PhonePair> = emptyList()) : PhonePairDirectory {
    private val lock = Any()
    private var current = pairs
    override fun snapshot(): List<PhonePair> = synchronized(lock) { current }
    override fun save(pairs: List<PhonePair>) {
        synchronized(lock) { current = pairs }
    }
    override fun noteSeen(id: String, now: Long) {
        synchronized(lock) {
            if (current.none { it.id == id }) return
            val next = PhonePairRules.touch(current, id, now)
            if (next !== current) current = next
        }
    }
    override fun recordCodeMiss() {
        synchronized(lock) { current = PhonePairRules.noteCodeMiss(current) }
    }
}

object PhonePairRules {
    const val NAME_LIMIT = 40
    const val SEEN_THROTTLE_MS = 60_000L
    const val DEFAULT_NAME = "This PC"

    /**
     * An install that already has one token becomes the first paired PC.
     * A list that already has entries is left as it is.
     */
    fun migrate(existing: List<PhonePair>, legacyHash: String?, legacyCode: String?, legacyFailures: Int): List<PhonePair> {
        if (existing.isNotEmpty()) return existing
        if (legacyHash == null || !legacyHash.matches(Regex("^[0-9a-f]{64}$"))) return emptyList()
        val code = legacyCode?.takeIf { it.startsWith("pbkdf2-sha256$") }
        return listOf(
            PhonePair(
                id = legacyHash,
                name = DEFAULT_NAME,
                tokenHash = legacyHash,
                codeRecord = code,
                codeFailures = legacyFailures.coerceAtLeast(0),
                lastSeenMs = 0,
            ),
        )
    }

    fun cleanName(raw: String?): String {
        val name = raw.orEmpty().replace('\n', ' ').replace('\r', ' ').trim().take(NAME_LIMIT).trim()
        return if (name.isEmpty()) "PC" else name
    }

    /** Last seen stays unset until that PC connects. */
    fun create(name: String, token: String, code: String, random: SecureRandom = SecureRandom()): PhonePair {
        val hash = PhoneShareAuth.hash(token)
        return PhonePair(
            id = hash,
            name = cleanName(name),
            tokenHash = hash,
            codeRecord = PhoneShareCode.hash(code, random),
            codeFailures = 0,
            lastSeenMs = 0,
        )
    }

    fun revoke(pairs: List<PhonePair>, id: String): List<PhonePair> = pairs.filterNot { it.id == id }

    /** Skip the write when this PC was seen in the last minute, so a directory listing does not save every time. */
    fun touch(pairs: List<PhonePair>, id: String, now: Long): List<PhonePair> {
        val pair = pairs.firstOrNull { it.id == id } ?: return pairs
        if (pair.lastSeenMs > 0 && now - pair.lastSeenMs < SEEN_THROTTLE_MS) return pairs
        return pairs.map { if (it.id == id) it.copy(lastSeenMs = now) else it }
    }

    /**
     * A wrong 6-digit code cannot be tied to one PC, so every code that is still active takes one strike.
     * A code already at the limit stays there. Tokens are not part of this count.
     */
    fun noteCodeMiss(pairs: List<PhonePair>): List<PhonePair> = pairs.map { pair ->
        if (pair.codeRecord != null && pair.codeFailures < PhoneShareCode.MAX_FAILURES) {
            pair.copy(codeFailures = pair.codeFailures + 1)
        } else {
            pair
        }
    }

    fun lastSeenLabel(seenMs: Long, now: Long): String {
        if (seenMs <= 0) return "Not yet"
        val delta = (now - seenMs).coerceAtLeast(0)
        if (delta < 60_000L) return "Just now"
        if (delta < 3_600_000L) {
            val minutes = (delta / 60_000L).toInt().coerceAtLeast(1)
            return if (minutes == 1) "1 min ago" else "$minutes min ago"
        }
        val hours = (delta / 3_600_000L).toInt().coerceAtLeast(1)
        return if (hours == 1) "1 h ago" else "$hours h ago"
    }

    fun peerIds(pairs: List<PhonePair>): List<String> =
        pairs.mapNotNull { PhoneShareLifecycle.peerId(it.tokenHash) }.distinct()
}

object PhonePairJson {
    fun encode(pairs: List<PhonePair>): String {
        val array = JSONArray()
        for (pair in pairs) {
            array.put(
                JSONObject()
                    .put("id", pair.id)
                    .put("name", pair.name)
                    .put("tokenHash", pair.tokenHash)
                    .put("codeRecord", pair.codeRecord ?: JSONObject.NULL)
                    .put("codeFailures", pair.codeFailures)
                    .put("lastSeenMs", pair.lastSeenMs),
            )
        }
        return array.toString()
    }

    fun decode(raw: String?): List<PhonePair> {
        if (raw.isNullOrBlank()) return emptyList()
        return try {
            val array = JSONArray(raw)
            buildList {
                for (i in 0 until array.length()) {
                    val obj = array.getJSONObject(i)
                    val id = obj.optString("id")
                    val hash = obj.optString("tokenHash")
                    if (!id.matches(Regex("^[0-9a-f]{64}$")) || hash.length != 64) continue
                    val code = if (obj.isNull("codeRecord")) {
                        null
                    } else {
                        obj.optString("codeRecord").takeIf { it.startsWith("pbkdf2-sha256$") }
                    }
                    add(
                        PhonePair(
                            id = id,
                            name = PhonePairRules.cleanName(obj.optString("name")),
                            tokenHash = hash,
                            codeRecord = code,
                            codeFailures = obj.optInt("codeFailures", 0).coerceAtLeast(0),
                            lastSeenMs = obj.optLong("lastSeenMs", 0),
                        ),
                    )
                }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }
}

/** Owner password for turning sharing on and for pairing or revoking. Stored only as PBKDF2. */
object PhoneOwnerPassword {
    const val MIN_LENGTH = 8
    const val MAX_LENGTH = 200

    fun acceptable(password: String?): Boolean {
        if (password == null) return false
        if (password.length < MIN_LENGTH || password.length > MAX_LENGTH) return false
        if (password.any { it == '\n' || it == '\r' }) return false
        return true
    }

    fun hash(password: String, random: SecureRandom = SecureRandom()): String = PhoneShareCode.hash(password, random)

    fun matches(password: String, record: String?): Boolean {
        if (!acceptable(password)) return false
        return PhoneShareCode.matchesAny(password, record)
    }

    /** A share that is already on keeps running across reboot. A user turning it on must know the password. */
    fun sharingAllowed(ownerRecord: String?, password: String?, alreadyEnabled: Boolean): Boolean {
        if (alreadyEnabled) return true
        if (ownerRecord.isNullOrBlank()) return false
        return matches(password.orEmpty(), ownerRecord)
    }

    fun manageAllowed(ownerRecord: String?, password: String?): Boolean = matches(password.orEmpty(), ownerRecord)
}

/**
 * Authorizes any paired PC. Each PC has its own token and its own 6-digit code.
 * Five wrong codes lock each active code; tokens keep working. Revoke drops that PC on the next request.
 */
class PhonePairGate(
    private val directory: PhonePairDirectory,
    private val onCodeLocked: (String) -> Unit = {},
    private val now: () -> Long = { System.currentTimeMillis() },
) : DavAuthorizer {
    private val lock = Any()
    private val verified = HashMap<String, Pair<String, ByteArray>>()
    private val accepted = ThreadLocal<String?>()

    override fun acceptedPeer(): String? = accepted.get()

    override fun authorized(header: String?, remote: String?): Boolean {
        accepted.set(null)
        val (user, secret) = PhoneShareAuth.parseBasic(header) ?: return false
        if (!user.equals(PhoneShareAuth.USER, ignoreCase = true)) return false
        synchronized(lock) {
            val pairs = directory.snapshot()
            if (PhoneShareAuth.looksLikeToken(secret)) {
                val hit = pairs.firstOrNull { PhoneShareAuth.matches(secret, it.tokenHash) } ?: return false
                return accept(hit.id, hit.tokenHash)
            }
            if (!PhoneShareCode.looksLikeCode(secret)) return false
            if (!PhoneShareCode.allowedFrom(remote)) return false
            for (pair in pairs) {
                val record = pair.codeRecord ?: continue
                if (pair.codeFailures >= PhoneShareCode.MAX_FAILURES) continue
                val fast = fastDigest(record, secret)
                val cached = verified[pair.id]
                if (cached != null && cached.first == record && MessageDigest.isEqual(cached.second, fast)) {
                    return accept(pair.id, pair.tokenHash)
                }
                if (PhoneShareCode.matches(secret, record)) {
                    verified[pair.id] = record to fast
                    return accept(pair.id, pair.tokenHash)
                }
            }
            // A code that belongs to a PC whose code is already locked is refused without striking the others.
            for (pair in pairs) {
                val record = pair.codeRecord ?: continue
                if (pair.codeFailures < PhoneShareCode.MAX_FAILURES) continue
                if (PhoneShareCode.matches(secret, record)) return false
            }
            directory.recordCodeMiss()
            val next = directory.snapshot()
            for (pair in next) {
                val before = pairs.firstOrNull { it.id == pair.id } ?: continue
                if (before.codeFailures < PhoneShareCode.MAX_FAILURES && pair.codeFailures >= PhoneShareCode.MAX_FAILURES) {
                    verified.remove(pair.id)
                    runCatching { onCodeLocked(pair.id) }
                }
            }
            return false
        }
    }

    private fun accept(id: String, tokenHash: String): Boolean {
        directory.noteSeen(id, now())
        if (directory.snapshot().none { it.id == id }) return false
        accepted.set(PhoneShareLifecycle.peerId(tokenHash))
        return true
    }

    private fun fastDigest(record: String, code: String): ByteArray =
        MessageDigest.getInstance("SHA-256").digest("$record|$code".toByteArray(Charsets.UTF_8))
}
