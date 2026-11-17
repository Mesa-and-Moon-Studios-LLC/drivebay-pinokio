package com.lordstryfe.drivebay

import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Join proof for adding this phone to the same Mesa and Moon login.
 * Matches joinProof / signJoin in app/src/lib/files/linked-crypto.mjs.
 *
 * The phone unlocks the account key (DEK) with the join password, then proves it holds the key
 * with an HMAC, and proves it owns its device key with an Ed25519 signature. Both cover the
 * host machine id, this phone's id, and a one-time request secret. Neither value is the password
 * or the key.
 */
object MesaJoin {
    fun message(hostId: String, peerId: String, secret: String): ByteArray =
        "drivebay-join-v1\u0000$hostId\u0000$peerId\u0000$secret".toByteArray(Charsets.UTF_8)

    fun joinKey(dek: ByteArray): ByteArray {
        val gen = HKDFBytesGenerator(SHA256Digest())
        gen.init(HKDFParameters(dek, "drivebay-join".toByteArray(Charsets.UTF_8), "drivebay-join-v1".toByteArray(Charsets.UTF_8)))
        return ByteArray(32).also { gen.generateBytes(it, 0, 32) }
    }

    fun proof(dek: ByteArray, hostId: String, peerId: String, secret: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(joinKey(dek), "HmacSHA256"))
        return MesaVault.b64(mac.doFinal(message(hostId, peerId, secret)))
    }

    /** The PKCS#8 Ed25519 key ends with the 32-byte seed. */
    fun signature(privateKeyB64: String, hostId: String, peerId: String, secret: String): String =
        sign(privateKeyB64, message(hostId, peerId, secret))

    fun reciprocalMessage(hostId: String, peerId: String, accessToken: String, issuedAt: String): ByteArray =
        "drivebay-reciprocal-v1\u0000$hostId\u0000$peerId\u0000$accessToken\u0000$issuedAt".toByteArray(Charsets.UTF_8)

    fun reciprocalSignature(privateKeyB64: String, hostId: String, peerId: String, accessToken: String, issuedAt: String): String =
        sign(privateKeyB64, reciprocalMessage(hostId, peerId, accessToken, issuedAt))

    fun forgetMessage(fromId: String, peerId: String, issuedAt: String): ByteArray =
        "drivebay-forget-v1\u0000$fromId\u0000$peerId\u0000$issuedAt".toByteArray(Charsets.UTF_8)

    fun forgetSignature(privateKeyB64: String, fromId: String, peerId: String, issuedAt: String): String =
        sign(privateKeyB64, forgetMessage(fromId, peerId, issuedAt))

    fun approvalMessage(approverId: String, joinerId: String, requestId: String, hostId: String, issuedAt: String): ByteArray =
        "drivebay-approval-v1\u0000$approverId\u0000$joinerId\u0000$requestId\u0000$hostId\u0000$issuedAt".toByteArray(Charsets.UTF_8)

    fun approvalProof(dek: ByteArray, approverId: String, joinerId: String, requestId: String): String =
        proof(dek, approverId, joinerId, "approve:$requestId")

    fun approvalSignature(privateKeyB64: String, approverId: String, joinerId: String, requestId: String, hostId: String, issuedAt: String): String =
        sign(privateKeyB64, approvalMessage(approverId, joinerId, requestId, hostId, issuedAt))

    fun sign(privateKeyB64: String, msg: ByteArray): String {
        val der = MesaVault.fromB64(privateKeyB64)
        require(der.size >= 32) { "Device key is too short." }
        val seed = der.copyOfRange(der.size - 32, der.size)
        val signer = Ed25519Signer()
        signer.init(true, Ed25519PrivateKeyParameters(seed, 0))
        signer.update(msg, 0, msg.size)
        return MesaVault.b64(signer.generateSignature())
    }

    /** Request secret: long enough for the host (16+), random per request. */
    fun newSecret(random: java.security.SecureRandom = java.security.SecureRandom()): String {
        val bytes = ByteArray(32).also { random.nextBytes(it) }
        return "dbp_" + bytes.joinToString("") { "%02x".format(it) }
    }

    /** Try each passphrase wrap from the cloud until one opens. Null when the password is wrong. */
    fun unlockWithPassword(wraps: org.json.JSONArray, password: String): ByteArray? {
        for (i in 0 until wraps.length()) {
            val wrap = wraps.optJSONObject(i) ?: continue
            if (wrap.optString("kind") != "passphrase") continue
            val dek = runCatching { MesaVault.unwrapWithPassphrase(wrap, password) }.getOrNull()
            if (dek != null && dek.size == 32) return dek
        }
        return null
    }

    fun verifyProof(dek: ByteArray, hostId: String, peerId: String, secret: String, proof: String): Boolean {
        if (proof.isBlank()) return false
        return proof(dek, hostId, peerId, secret) == proof
    }

    fun verifySignature(publicKeyB64: String, hostId: String, peerId: String, secret: String, signature: String): Boolean {
        return runCatching {
            val der = MesaVault.fromB64(publicKeyB64)
            if (der.size < 32) return false
            val pub = der.copyOfRange(der.size - 32, der.size)
            val verifier = Ed25519Signer()
            verifier.init(false, Ed25519PublicKeyParameters(pub, 0))
            val msg = message(hostId, peerId, secret)
            verifier.update(msg, 0, msg.size)
            verifier.verifySignature(MesaVault.fromB64(signature))
        }.getOrDefault(false)
    }

    fun verifyApprovalSignature(publicKeyB64: String, approverId: String, joinerId: String, requestId: String, hostId: String, issuedAt: String, signature: String): Boolean {
        return runCatching {
            val der = MesaVault.fromB64(publicKeyB64)
            if (der.size < 32) return false
            val pub = der.copyOfRange(der.size - 32, der.size)
            val verifier = Ed25519Signer()
            verifier.init(false, Ed25519PublicKeyParameters(pub, 0))
            val msg = approvalMessage(approverId, joinerId, requestId, hostId, issuedAt)
            verifier.update(msg, 0, msg.size)
            verifier.verifySignature(MesaVault.fromB64(signature))
        }.getOrDefault(false)
    }
}
