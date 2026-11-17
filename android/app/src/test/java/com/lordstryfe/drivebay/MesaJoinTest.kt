package com.lordstryfe.drivebay

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Vectors come from the Node implementation (linked-crypto.mjs). Ed25519 is deterministic,
 * so the phone must produce the exact same signature the desktop host verifies.
 */
class MesaJoinTest {
    private val dek = MesaVault.fromB64("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=")
    private val hostId = "host-machine-0001"
    private val peerId = "phone-1978c6ebc8c04036"
    private val secret = "dbp_abababababababababababababababababababababababababababababababab"

    @Test fun proofMatchesTheDesktopHost() {
        assertEquals("HlczPbd0pjb6ZHowkh2An0mF1ecAw25N1Md4AOD9VQQ=", MesaJoin.proof(dek, hostId, peerId, secret))
    }

    @Test fun proofIsBoundToHostMachineAndSecret() {
        val proof = MesaJoin.proof(dek, hostId, peerId, secret)
        assertFalse(proof == MesaJoin.proof(dek, "other-host-0001", peerId, secret))
        assertFalse(proof == MesaJoin.proof(dek, hostId, "phone-other-0002", secret))
        assertFalse(proof == MesaJoin.proof(dek, hostId, peerId, secret + "x"))
        assertFalse(proof == MesaJoin.proof(ByteArray(32) { 1 }, hostId, peerId, secret))
        assertFalse(proof.contains(MesaVault.b64(dek)))
    }

    @Test fun signatureMatchesTheDesktopHost() {
        assertEquals("C36YTO8ZdRJaCNnUpHBJAL4VpKalL0/A5GA7CZ7a7raokNoQv7Gw785z4SAxFLONszdnl1LX6zDS+aEprtvOCw==", MesaJoin.signature("MC4CAQAwBQYDK2VwBCIEICmwJa9gLiF5bAd804u9pR4rrqttxL8hNpffgGULaPQB", hostId, peerId, secret))
    }

    @Test fun joinPasswordOpensThePassphraseWrapAndAWrongOneDoesNot() {
        val wraps = JSONArray().put(JSONObject("""{"wrapId": "f376bb81-a3fd-4a69-9142-7d5bf6b6c673", "kind": "passphrase", "alg": "argon2id-aes-256-gcm", "salt": "/72DUolwqBufAFV7AdEyfA==", "nonce": "VLZjTudTfwBe24nz", "wrappedDek": "hoK7K271Kwsp5qez8nMds5UplVquqHECK1MQZ5dwN1En3r2U/WfqB6VI3ZvaA6fb", "params": {"t": 2, "m": 19456, "p": 1, "dkLen": 32, "version": 19}, "credentialId": ""}"""))
        val opened = MesaJoin.unlockWithPassword(wraps, "correct horse battery")
        assertNotNull(opened)
        assertTrue(opened!!.contentEquals(dek))
        assertNull(MesaJoin.unlockWithPassword(wraps, "wrong horse battery"))
        // A recovery or passkey wrap is not tried with a typed password.
        val other = JSONObject("""{"wrapId": "f376bb81-a3fd-4a69-9142-7d5bf6b6c673", "kind": "passphrase", "alg": "argon2id-aes-256-gcm", "salt": "/72DUolwqBufAFV7AdEyfA==", "nonce": "VLZjTudTfwBe24nz", "wrappedDek": "hoK7K271Kwsp5qez8nMds5UplVquqHECK1MQZ5dwN1En3r2U/WfqB6VI3ZvaA6fb", "params": {"t": 2, "m": 19456, "p": 1, "dkLen": 32, "version": 19}, "credentialId": ""}""").put("kind", "recovery")
        assertNull(MesaJoin.unlockWithPassword(JSONArray().put(other), "correct horse battery"))
    }

    @Test fun requestSecretsAreLongAndDifferent() {
        val a = MesaJoin.newSecret()
        val b = MesaJoin.newSecret()
        assertTrue(a.length >= 16)
        assertFalse(a == b)
    }
}
