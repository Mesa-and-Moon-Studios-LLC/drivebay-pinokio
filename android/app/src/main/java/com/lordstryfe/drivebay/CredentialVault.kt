package com.lordstryfe.drivebay

import android.content.Context
import android.util.Base64
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * Saved sign-in passwords for remembered servers.
 * The password is AES-GCM encrypted with a key derived from a random secret that
 * stays in app-private storage. There is no plaintext password file.
 */
class CredentialVault(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val secretPrefs = context.getSharedPreferences(SECRET_PREFS, Context.MODE_PRIVATE)

    fun has(id: String): Boolean = prefs.contains(id)

    fun load(id: String): String? {
        val packed = prefs.getString(id, null) ?: return null
        return try {
            decrypt(packed)
        } catch (_: Exception) {
            null
        }
    }

    fun save(id: String, password: String) {
        prefs.edit().putString(id, encrypt(password)).apply()
    }

    fun forget(id: String) {
        prefs.edit().remove(id).apply()
    }

    private fun encrypt(plain: String): String {
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(), GCMParameterSpec(128, iv))
        val body = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(iv + body, Base64.NO_WRAP)
    }

    private fun decrypt(packed: String): String {
        val raw = Base64.decode(packed, Base64.NO_WRAP)
        if (raw.size < 13) throw IllegalArgumentException("short")
        val iv = raw.copyOfRange(0, 12)
        val body = raw.copyOfRange(12, raw.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        return String(cipher.doFinal(body), Charsets.UTF_8)
    }

    private fun key(): SecretKeySpec {
        val existing = secretPrefs.getString(KEY_SECRET, null)
        val secret = if (existing != null) {
            existing
        } else {
            val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
            val created = Base64.encodeToString(bytes, Base64.NO_WRAP)
            secretPrefs.edit().putString(KEY_SECRET, created).apply()
            created
        }
        val spec = PBEKeySpec(secret.toCharArray(), "drivebay-vault".toByteArray(), 10_000, 256)
        val encoded = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        return SecretKeySpec(encoded, "AES")
    }

    companion object {
        private const val PREFS = "drivebay_vault"
        private const val SECRET_PREFS = "drivebay_vault_key"
        private const val KEY_SECRET = "secret"
    }
}
