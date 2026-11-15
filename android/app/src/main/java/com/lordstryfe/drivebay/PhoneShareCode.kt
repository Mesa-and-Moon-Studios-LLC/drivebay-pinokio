package com.lordstryfe.drivebay

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * Where the 6-digit code's hash and failure count live. SharedPreferences on the phone,
 * a plain object in tests. The code itself is never stored.
 */
interface PhoneShareCodeState {
    /** "pbkdf2-sha256$iterations$saltHex$hashHex", or null when there is no code. */
    fun codeRecord(): String?
    fun codeFailures(): Int

    /** Must be durable before it returns, so a restart can't reset the lockout. */
    fun saveCodeFailures(count: Int)
    fun saveCode(record: String?, failures: Int)
}

/**
 * A short code for typing into Windows' Map network drive box, next to the long db_ token.
 * Accepted only from Tailscale or private LAN addresses, and switched off after
 * [MAX_FAILURES] wrong tries in total until a new token is made.
 */
object PhoneShareCode {
    const val LENGTH = 6
    const val MAX_FAILURES = 5
    private const val ITERATIONS = 20_000
    private const val PREFIX = "pbkdf2-sha256"
    private val SHAPE = Regex("^[0-9]{6}$")

    fun generate(random: SecureRandom = SecureRandom()): String = "%06d".format(random.nextInt(1_000_000))

    fun looksLikeCode(value: String): Boolean = SHAPE.matches(value)

    fun hash(code: String, random: SecureRandom = SecureRandom(), iterations: Int = ITERATIONS): String {
        val salt = ByteArray(16).also { random.nextBytes(it) }
        return "$PREFIX$$iterations$${hex(salt)}$${hex(derive(code, salt, iterations))}"
    }

    /** Constant-time check of [code] against a stored record. False for any malformed record. */
    fun matches(code: String, record: String?): Boolean {
        val parts = parse(record) ?: return false
        if (!looksLikeCode(code)) {
            // Same amount of work either way.
            MessageDigest.isEqual(derive("000000", parts.salt, parts.iterations), parts.hash)
            return false
        }
        return MessageDigest.isEqual(derive(code, parts.salt, parts.iterations), parts.hash)
    }

    /**
     * Same check as [matches] for a secret that is not a 6-digit code, such as the owner password.
     * A blank, huge, or multi-line secret still pays for one derive and then fails.
     */
    fun matchesAny(secret: String, record: String?): Boolean {
        val parts = parse(record) ?: return false
        if (secret.isEmpty() || secret.length > 200 || secret.any { it == '\n' || it == '\r' }) {
            MessageDigest.isEqual(derive("000000", parts.salt, parts.iterations), parts.hash)
            return false
        }
        return MessageDigest.isEqual(derive(secret, parts.salt, parts.iterations), parts.hash)
    }

    /** The code is a LAN/Tailscale convenience only. The full token works from anywhere, as before. */
    fun allowedFrom(remote: String?): Boolean {
        if (remote.isNullOrBlank()) return false
        val v = remote.trim().lowercase().removePrefix("[").substringBefore("]").substringBefore('%')
        if (v == "::1" || v == "0:0:0:0:0:0:0:1") return true
        if (v.contains(':') && !v.startsWith("::ffff:")) {
            // Tailscale fd7a:115c:a1e0::/48, link-local fe80::/10, unique-local fc00::/7.
            val first = v.substringBefore(':').toIntOrNull(16) ?: return false
            if (v.startsWith("fd7a:115c:a1e0:")) return true
            if (first in 0xfe80..0xfebf) return true
            return first in 0xfc00..0xfdff
        }
        return PhoneShareNet.isPrivateOrTailscale(v)
    }

    private class Parts(val iterations: Int, val salt: ByteArray, val hash: ByteArray)

    private fun parse(record: String?): Parts? {
        val p = record?.split('$') ?: return null
        if (p.size != 4 || p[0] != PREFIX) return null
        val iterations = p[1].toIntOrNull()?.takeIf { it in 1..1_000_000 } ?: return null
        val salt = unhex(p[2]) ?: return null
        val hash = unhex(p[3]) ?: return null
        if (salt.size < 8 || hash.size != 32) return null
        return Parts(iterations, salt, hash)
    }

    fun derive(code: String, salt: ByteArray, iterations: Int): ByteArray {
        val spec = PBEKeySpec(code.toCharArray(), salt, iterations, 256)
        return try {
            SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        } finally {
            spec.clearPassword()
        }
    }

    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

    private fun unhex(s: String): ByteArray? {
        if (s.length % 2 != 0 || s.isEmpty()) return null
        return try {
            ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
        } catch (_: NumberFormatException) {
            null
        }
    }
}

/**
 * Decides Basic auth for the WebDAV server: the db_ token from anywhere it is served today,
 * or the 6-digit code from Tailscale/LAN only, with a persisted 5-strike lockout.
 */
class PhoneShareGate(
    private val tokenHash: String,
    private val codeState: PhoneShareCodeState? = null,
    private val onCodeLocked: () -> Unit = {},
) : DavAuthorizer {
    private val lock = Any()

    /** After one good PBKDF2 check, later requests compare a fast salted digest instead. */
    @Volatile private var verified: Pair<String, ByteArray>? = null

    override fun authorized(header: String?, remote: String?): Boolean {
        val (user, secret) = PhoneShareAuth.parseBasic(header) ?: return false
        if (!user.equals(PhoneShareAuth.USER, ignoreCase = true)) return false
        if (PhoneShareAuth.looksLikeToken(secret)) return PhoneShareAuth.matches(secret, tokenHash)
        if (!PhoneShareCode.looksLikeCode(secret)) return false
        val state = codeState ?: return false
        // Outside Tailscale/LAN the code is never checked and never counts as a failure.
        if (!PhoneShareCode.allowedFrom(remote)) return false
        synchronized(lock) {
            val record = state.codeRecord() ?: return false
            if (state.codeFailures() >= PhoneShareCode.MAX_FAILURES) return false
            val fast = fastDigest(record, secret)
            val cached = verified
            if (cached != null && cached.first == record && java.security.MessageDigest.isEqual(cached.second, fast)) return true
            if (PhoneShareCode.matches(secret, record)) {
                verified = record to fast
                return true
            }
            val failures = state.codeFailures() + 1
            state.saveCodeFailures(failures)
            if (failures >= PhoneShareCode.MAX_FAILURES) {
                verified = null
                runCatching(onCodeLocked)
            }
            return false
        }
    }

    private fun fastDigest(record: String, code: String): ByteArray =
        java.security.MessageDigest.getInstance("SHA-256").digest("$record|$code".toByteArray(Charsets.UTF_8))
}

/** In-memory state for tests and for a phone build with no prefs yet. */
class MemoryCodeState(private var record: String? = null, private var failures: Int = 0) : PhoneShareCodeState {
    override fun codeRecord(): String? = record
    override fun codeFailures(): Int = failures
    override fun saveCodeFailures(count: Int) { failures = count }
    override fun saveCode(record: String?, failures: Int) {
        this.record = record
        this.failures = failures
    }
}
