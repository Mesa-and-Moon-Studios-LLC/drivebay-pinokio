package com.lordstryfe.drivebay.license

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Uses the same docs/license-test-vectors.json as the JS and PHP tests, so all three agree byte for byte. */
class LicenseCodecTest {
    private val vectors: JSONObject = run {
        val candidates = listOf(File("../../docs/license-test-vectors.json"), File("../docs/license-test-vectors.json"), File("docs/license-test-vectors.json"))
        JSONObject(candidates.first { it.exists() }.readText())
    }
    private val pk = listOf(LicenseCodec.hexToBytes(vectors.getString("publicKeyHex")))
    private val issued = vectors.getLong("issued")
    private val day = 86400L

    @Test
    fun serverSignedVectorsVerifyAndDecodeToTheSameFields() {
        val list = vectors.getJSONArray("licenses")
        for (i in 0 until list.length()) {
            val v = list.getJSONObject(i)
            val out = LicenseCodec.verifyKey(v.getString("key"), pk)
            assertTrue(v.getString("name"), out.ok)
            val e = v.getJSONObject("expect")
            val l = out.license!!
            assertEquals(e.getString("edition"), l.edition)
            assertEquals(e.getInt("seats"), l.seats)
            assertEquals(e.getBoolean("offline"), l.offline)
            assertEquals(e.getLong("issued"), l.issued)
            assertEquals(if (e.isNull("expires")) null else e.getLong("expires"), l.expires)
            assertEquals(if (e.isNull("updatesUntil")) null else e.getLong("updatesUntil"), l.updatesUntil)
            assertEquals(e.getString("id"), l.id)
            assertEquals(e.getString("label"), l.label)
        }
    }

    @Test
    fun tamperedKeysAreRejected() {
        val list = vectors.getJSONArray("tamperedKeys")
        for (i in 0 until list.length()) assertFalse(list.getJSONObject(i).getString("name"), LicenseCodec.verifyKey(list.getJSONObject(i).getString("key"), pk).ok)
    }

    @Test
    fun keySignedByAnotherKeyIsRejected() {
        val other = Ed25519PrivateKeyParameters(ByteArray(32) { 7 }, 0).generatePublicKey().encoded
        assertFalse(LicenseCodec.verifyKey(vectors.getJSONArray("licenses").getJSONObject(0).getString("key"), listOf(other)).ok)
    }

    @Test
    fun editedSeatCountFailsTheSignature() {
        val key = vectors.getJSONArray("licenses").getJSONObject(0).getString("key")
        val raw = LicenseCodec.b32Decode(key.substring(4))!!
        raw[3] = 0x7f
        val forged = "DBAY-" + LicenseCodec.b32Encode(raw).chunked(5).joinToString("-")
        assertFalse(LicenseCodec.verifyKey(forged, pk).ok)
        assertTrue(LicenseCodec.verifyKey(key.lowercase().replace('-', ' '), pk).ok)
    }

    @Test
    fun expiryAndUpdatesWindow() {
        val licenses = vectors.getJSONArray("licenses")
        val sub = LicenseCodec.verifyKey(licenses.getJSONObject(1).getString("key"), pk).license!!
        assertEquals("active", LicenseCodec.state(sub, issued + 100 * day))
        assertEquals("expired", LicenseCodec.state(sub, issued + 400 * day))
        val perpetual = LicenseCodec.verifyKey(licenses.getJSONObject(0).getString("key"), pk).license!!
        assertEquals("active", LicenseCodec.state(perpetual, issued + 5000 * day))
        assertEquals("active", LicenseCodec.state(perpetual, issued + 500 * day, issued + 100 * day))
        assertEquals("updates_ended", LicenseCodec.state(perpetual, issued + 500 * day, issued + 400 * day))
    }

    @Test
    fun receiptBindsToTheMachineAndExpires() {
        val r = vectors.getJSONObject("receipt")
        val text = r.getString("text")
        assertTrue(LicenseCodec.verifyReceipt(text, r.getString("machineId"), pk, issued + 10).ok)
        assertEquals("machine", LicenseCodec.verifyReceipt(text, r.getString("otherMachineId"), pk, issued + 10).error)
        assertEquals("receipt_expired", LicenseCodec.verifyReceipt(text, r.getString("machineId"), pk, r.getLong("validUntil") + 1).error)
        assertFalse(LicenseCodec.verifyReceipt(text.dropLast(3) + "AAA", r.getString("machineId"), pk, issued + 10).ok)
    }

    @Test
    fun purchaseCodeCheckCharacter() {
        val list = vectors.getJSONArray("purchaseCodes")
        for (i in 0 until list.length()) {
            val c = list.getJSONObject(i)
            assertEquals(c.getString("code"), c.getBoolean("valid"), LicenseCodec.normalisePurchaseCode(c.getString("code")) != null)
        }
        assertEquals("code", LicenseCodec.classify(list.getJSONObject(0).getString("code")))
        assertEquals("long", LicenseCodec.classify(vectors.getJSONArray("licenses").getJSONObject(0).getString("key")))
        assertEquals("", LicenseCodec.classify("hello"))
        assertNull(LicenseCodec.normalisePurchaseCode("DBAY-1111"))
    }

    @Test
    fun licenseFileTextIsUnderstood() {
        val key = vectors.getJSONArray("licenses").getJSONObject(2).getString("key")
        val file = "-----BEGIN DRIVEBAY LICENSE-----\nLicensee: Acme\nEdition: enterprise\nKey: $key\n-----END DRIVEBAY LICENSE-----\n"
        assertEquals(key, LicenseCodec.extractKeyInput(file))
        assertNotNull(LicenseCodec.verifyKey(LicenseCodec.extractKeyInput(file), pk).license)
    }

    @Test
    fun policyMatchesTheDesktopTable() {
        assertFalse(EditionPolicy.allows("free", "remote_access"))
        assertTrue(EditionPolicy.allows("pro", "remote_access"))
        assertFalse(EditionPolicy.allows("pro", "remote_24h"))
        assertTrue(EditionPolicy.allows("elite", "remote_24h"))
        assertTrue(EditionPolicy.allows("enterprise", "public_access"))
        assertEquals(3, EditionPolicy.sharedFolderLimit("free"))
        assertEquals(-1, EditionPolicy.sharedFolderLimit("elite"))
        assertTrue(EditionPolicy.upgradeMessage("remote_access").contains("Your own machines still link and open each other for free"))
    }

    @Test
    fun productionKeyIsA32ByteKey() {
        for (k in LicenseConfig.PUBLIC_KEYS_HEX) assertEquals(64, k.length)
        assertEquals(1, LicenseConfig.publicKeys().size)
        // sanity: Ed25519Signer is available for verification
        assertNotNull(Ed25519Signer())
    }
}
