package com.lordstryfe.drivebay

import android.util.Base64
import org.bouncycastle.crypto.generators.Ed25519KeyPairGenerator
import org.bouncycastle.crypto.params.Ed25519KeyGenerationParameters
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import java.security.SecureRandom

/**
 * Ed25519 keypair in the same SPKI / PKCS#8 shape the desktop app uploads.
 * The private key stays on this phone.
 */
object MachineKeys {
    private val spkiPrefix = hex("302a300506032b6570032100")
    private val pkcs8Prefix = hex("302e020100300506032b657004220420")

    data class Pair(val publicKey: String, val privateKey: String)

    fun generate(random: SecureRandom = SecureRandom()): Pair {
        val generator = Ed25519KeyPairGenerator()
        generator.init(Ed25519KeyGenerationParameters(random))
        val generated = generator.generateKeyPair()
        val pub = (generated.public as Ed25519PublicKeyParameters).encoded
        val seed = (generated.private as Ed25519PrivateKeyParameters).encoded
        return Pair(
            publicKey = Base64.encodeToString(spkiPrefix + pub, Base64.NO_WRAP),
            privateKey = Base64.encodeToString(pkcs8Prefix + seed, Base64.NO_WRAP),
        )
    }

    fun looksLikePublicKey(value: String): Boolean {
        val raw = runCatching { Base64.decode(value, Base64.DEFAULT) }.getOrNull() ?: return false
        return raw.size >= 44
    }

    private fun hex(value: String): ByteArray {
        val out = ByteArray(value.length / 2)
        for (i in out.indices) {
            out[i] = value.substring(i * 2, i * 2 + 2).toInt(16).toByte()
        }
        return out
    }
}
