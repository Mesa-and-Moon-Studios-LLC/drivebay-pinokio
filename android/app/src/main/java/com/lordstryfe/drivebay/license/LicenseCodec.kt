package com.lordstryfe.drivebay.license

import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.security.MessageDigest

/**
 * Drivebay license keys, purchase codes and activation receipts (format v1).
 * Same byte layout as app/src/lib/license/license-codec.mjs and server/cloud-api/lib/license_crypto.php.
 * Verification is offline and needs only Ed25519 public keys.
 */
data class License(
    val edition: String,
    val seats: Int,
    val offline: Boolean,
    val issued: Long,
    val expires: Long?,
    val updatesUntil: Long?,
    val id: String,
    val label: String,
)

data class KeyCheck(val ok: Boolean, val error: String, val license: License?)
data class ReceiptCheck(val ok: Boolean, val error: String, val licenseId: String = "", val validUntil: Long = 0)

object LicenseCodec {
    const val LICENSE_EPOCH = 1767225600L
    private const val DAY = 86400L
    private const val LIFETIME = 0xFFFF
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private val EDITIONS = mapOf(1 to "pro", 2 to "elite", 3 to "enterprise")
    private val LICENSE_DOMAIN = "DRIVEBAY-LICENSE-v1\u0000".toByteArray(Charsets.ISO_8859_1)
    private val RECEIPT_DOMAIN = "DRIVEBAY-RECEIPT-v1\u0000".toByteArray(Charsets.ISO_8859_1)

    fun b32Encode(bytes: ByteArray): String {
        val sb = StringBuilder()
        var buffer = 0
        var bits = 0
        for (b in bytes) {
            buffer = (buffer shl 8) or (b.toInt() and 0xFF)
            bits += 8
            while (bits >= 5) {
                sb.append(ALPHABET[(buffer shr (bits - 5)) and 31])
                bits -= 5
            }
        }
        if (bits > 0) sb.append(ALPHABET[(buffer shl (5 - bits)) and 31])
        return sb.toString()
    }

    /** Tolerant: case-insensitive, I/L read as 1, O reads as 0, spaces and dashes ignored. Null on bad input. */
    fun b32Decode(text: String): ByteArray? {
        val clean = text.uppercase().filter { !it.isWhitespace() && it != '-' }.replace('I', '1').replace('L', '1').replace('O', '0')
        val out = java.io.ByteArrayOutputStream()
        var buffer = 0
        var bits = 0
        for (ch in clean) {
            val pos = ALPHABET.indexOf(ch)
            if (pos < 0) return null
            buffer = (buffer shl 5) or pos
            bits += 5
            if (bits >= 8) {
                out.write((buffer shr (bits - 8)) and 0xFF)
                bits -= 8
            }
            buffer = buffer and ((1 shl bits) - 1)
        }
        if (bits > 0 && buffer != 0) return null
        return out.toByteArray()
    }

    private fun verifyDomain(domain: ByteArray, message: ByteArray, signature: ByteArray, publicKeys: List<ByteArray>): Boolean {
        if (signature.size != 64) return false
        val data = domain + message
        for (key in publicKeys) {
            if (key.size != 32) continue
            val signer = Ed25519Signer()
            signer.init(false, Ed25519PublicKeyParameters(key, 0))
            signer.update(data, 0, data.size)
            if (signer.verifySignature(signature)) return true
        }
        return false
    }

    private fun u16(b: ByteArray, o: Int) = ((b[o].toInt() and 0xFF) shl 8) or (b[o + 1].toInt() and 0xFF)
    private fun u32(b: ByteArray, o: Int): Long =
        ((b[o].toLong() and 0xFF) shl 24) or ((b[o + 1].toLong() and 0xFF) shl 16) or ((b[o + 2].toLong() and 0xFF) shl 8) or (b[o + 3].toLong() and 0xFF)

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    fun parsePayload(p: ByteArray): License? {
        if (p.size < 20 || p[0].toInt() != 1) return null
        val edition = EDITIONS[p[1].toInt() and 0xFF] ?: return null
        val labelLen = p[19].toInt() and 0xFF
        if (labelLen > 48 || p.size != 20 + labelLen) return null
        val expiresDay = u16(p, 7)
        val updatesDay = u16(p, 9)
        return License(
            edition = edition,
            seats = u16(p, 2),
            offline = (p[4].toInt() and 1) == 1,
            issued = LICENSE_EPOCH + u16(p, 5) * DAY,
            expires = if (expiresDay == 0) null else LICENSE_EPOCH + expiresDay * DAY,
            updatesUntil = if (updatesDay == LIFETIME) null else LICENSE_EPOCH + updatesDay * DAY,
            id = hex(p.copyOfRange(11, 19)),
            label = String(p, 20, labelLen, Charsets.UTF_8),
        )
    }

    /** Checks the signature only. Use [state] for expiry and the updates window. */
    fun verifyKey(keyText: String, publicKeys: List<ByteArray>): KeyCheck {
        val text = keyText.trim()
        if (!text.startsWith("DBAY", ignoreCase = true)) return KeyCheck(false, "format", null)
        val raw = b32Decode(text.substring(4)) ?: return KeyCheck(false, "format", null)
        if (raw.size < 20 + 64) return KeyCheck(false, "format", null)
        val payload = raw.copyOfRange(0, raw.size - 64)
        val signature = raw.copyOfRange(raw.size - 64, raw.size)
        if (!verifyDomain(LICENSE_DOMAIN, payload, signature, publicKeys)) return KeyCheck(false, "signature", null)
        val license = parsePayload(payload) ?: return KeyCheck(false, "format", null)
        return KeyCheck(true, "", license)
    }

    /** "active", "expired" or "updates_ended". Times in seconds; buildTs is the app build time. */
    fun state(license: License, now: Long, buildTs: Long? = null): String {
        val expires = license.expires
        if (expires != null && now >= expires + DAY) return "expired"
        val updates = license.updatesUntil
        if (buildTs != null && updates != null && buildTs > updates + DAY) return "updates_ended"
        return "active"
    }

    private fun machineHash(machineId: String): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(machineId.toByteArray(Charsets.UTF_8)).copyOf(8)

    fun verifyReceipt(text: String, machineId: String, publicKeys: List<ByteArray>, now: Long): ReceiptCheck {
        if (!text.startsWith("DBAR1.")) return ReceiptCheck(false, "format")
        val raw = runCatching { java.util.Base64.getUrlDecoder().decode(text.substring(6)) }.getOrNull()
            ?: return ReceiptCheck(false, "format")
        if (raw.size != 25 + 64) return ReceiptCheck(false, "format")
        val payload = raw.copyOfRange(0, 25)
        val signature = raw.copyOfRange(25, raw.size)
        if (payload[0].toInt() != 1 || !verifyDomain(RECEIPT_DOMAIN, payload, signature, publicKeys)) return ReceiptCheck(false, "signature")
        val licenseId = hex(payload.copyOfRange(1, 9))
        if (!payload.copyOfRange(9, 17).contentEquals(machineHash(machineId))) return ReceiptCheck(false, "machine")
        val validUntil = u32(payload, 21)
        if (now >= validUntil) return ReceiptCheck(false, "receipt_expired", licenseId)
        return ReceiptCheck(true, "", licenseId, validUntil)
    }

    /** The 16-character form of a purchase code, or null (wrong length, bad character, bad check character). */
    fun normalisePurchaseCode(text: String): String? {
        val upper = text.trim().uppercase()
        if (!upper.startsWith("DBAY")) return null
        val rest = upper.substring(4).filter { !it.isWhitespace() && it != '-' }.replace('I', '1').replace('L', '1').replace('O', '0')
        if (rest.length != 16 || rest.any { ALPHABET.indexOf(it) < 0 }) return null
        return if (checkChar(rest.substring(0, 15)) == rest[15]) rest else null
    }

    fun checkChar(fifteen: String): Char {
        var sum = 0
        for (i in 0 until 15) sum += (ALPHABET.indexOf(fifteen[i]) + 1) * (i + 3)
        return ALPHABET[sum % 32]
    }

    /** "code", "long" or "" */
    fun classify(text: String): String {
        val t = text.trim()
        if (!t.startsWith("DBAY", ignoreCase = true)) return ""
        if (normalisePurchaseCode(t) != null) return "code"
        return if (t.filter { !it.isWhitespace() && it != '-' }.length > 60) "long" else ""
    }

    /** Pull the key out of a pasted code or the text of a .dbaylicense file. */
    fun extractKeyInput(text: String): String {
        val raw = text.trim()
        if (raw.isEmpty()) return ""
        val line = raw.lines().map { it.trim() }.firstOrNull { it.matches(Regex("(?i)^key\\s*:.*")) }
        if (line != null) return line.replaceFirst(Regex("(?i)^key\\s*:\\s*"), "").trim()
        return raw
    }

    fun hexToBytes(hex: String): ByteArray = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
