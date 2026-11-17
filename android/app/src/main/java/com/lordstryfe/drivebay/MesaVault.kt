package com.lordstryfe.drivebay

import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Account DEK, Argon2id wraps, and AES-256-GCM directory envelopes.
 * Matches app/src/lib/files/linked-crypto.mjs.
 */
object MesaVault {
    const val CANNOT_RECOVER =
        "Mesa and Moon cannot recover this. If you lose the passphrase, the passkey, and the recovery key, you will need to lock the list again and re-pair your machines. Your files stay on your devices and are not affected."

    private val directoryKeys = listOf(
        "displayName", "type", "tailscaleHost", "lanAddress", "port",
        "publicKey", "hidden", "directInternet", "publicHost",
    )

    fun newDek(random: SecureRandom = SecureRandom()): ByteArray = ByteArray(32).also { random.nextBytes(it) }

    // java.util.Base64 (API 26+) so the same code runs in JVM unit tests.
    fun b64(data: ByteArray): String = java.util.Base64.getEncoder().encodeToString(data)
    fun fromB64(value: String): ByteArray = java.util.Base64.getMimeDecoder().decode(value)

    fun aesGcmEncrypt(key: ByteArray, plaintext: ByteArray, random: SecureRandom = SecureRandom()): Pair<String, String> {
        val nonce = ByteArray(12).also { random.nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        val packed = cipher.doFinal(plaintext)
        return b64(nonce) to b64(packed)
    }

    fun aesGcmDecrypt(key: ByteArray, nonceB64: String, ciphertextB64: String): ByteArray {
        val nonce = fromB64(nonceB64)
        val packed = fromB64(ciphertextB64)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        return cipher.doFinal(packed)
    }

    fun encryptDirectory(dek: ByteArray, fields: JSONObject): JSONObject {
        val payload = JSONObject()
        for (key in directoryKeys) payload.put(key, fields.opt(key))
        val sealed = aesGcmEncrypt(dek, payload.toString().toByteArray(Charsets.UTF_8))
        return JSONObject()
            .put("machineId", fields.getString("machineId"))
            .put("lastSeen", fields.getString("lastSeen"))
            .put("ciphertext", sealed.second)
            .put("nonce", sealed.first)
            .put("envelopeVersion", 2)
    }

    fun decryptDirectory(dek: ByteArray, envelope: JSONObject): JSONObject {
        val raw = JSONObject(aesGcmDecrypt(dek, envelope.getString("nonce"), envelope.getString("ciphertext")).toString(Charsets.UTF_8))
        raw.put("machineId", envelope.getString("machineId"))
        raw.put("lastSeen", envelope.getString("lastSeen"))
        return raw
    }

    fun argon2id(passphrase: String, salt: ByteArray): ByteArray {
        val params = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withSalt(salt)
            .withIterations(2)
            .withMemoryAsKB(19456)
            .withParallelism(1)
            .withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .build()
        val gen = Argon2BytesGenerator()
        gen.init(params)
        val out = ByteArray(32)
        gen.generateBytes(passphrase.toByteArray(Charsets.UTF_8), out)
        return out
    }

    fun wrapWithPassphrase(dek: ByteArray, passphrase: String, random: SecureRandom = SecureRandom()): JSONObject {
        val salt = ByteArray(16).also { random.nextBytes(it) }
        val kek = argon2id(passphrase, salt)
        val sealed = aesGcmEncrypt(kek, dek, random)
        val params = JSONObject().put("t", 2).put("m", 19456).put("p", 1).put("dkLen", 32).put("version", 0x13)
        return JSONObject()
            .put("wrapId", java.util.UUID.randomUUID().toString())
            .put("kind", "passphrase")
            .put("alg", "argon2id-aes-256-gcm")
            .put("salt", b64(salt))
            .put("nonce", sealed.first)
            .put("wrappedDek", sealed.second)
            .put("params", params)
            .put("credentialId", "")
    }

    fun unwrapWithPassphrase(wrap: JSONObject, passphrase: String): ByteArray {
        val kek = argon2id(passphrase, fromB64(wrap.getString("salt")))
        return aesGcmDecrypt(kek, wrap.getString("nonce"), wrap.getString("wrappedDek"))
    }

    fun openMachines(dek: ByteArray, machines: JSONArray): JSONArray {
        val out = JSONArray()
        for (i in 0 until machines.length()) {
            val row = machines.getJSONObject(i)
            if (row.optInt("envelopeVersion") == 2 && row.optString("ciphertext").isNotBlank()) {
                out.put(decryptDirectory(dek, row))
            } else {
                out.put(row)
            }
        }
        return out
    }
}
