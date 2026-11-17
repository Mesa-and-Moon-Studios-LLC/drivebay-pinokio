package com.lordstryfe.drivebay.license

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest

/** LicenseManager against a fake in-memory license server that signs with a test key. */
class LicenseManagerTest {
    private val day = 86400L
    private val now0 = 1_795_000_000L
    private val seed = ByteArray(32) { (it + 1).toByte() }
    private val sk = Ed25519PrivateKeyParameters(seed, 0)
    private val pk = listOf(sk.generatePublicKey().encoded)

    private fun sign(domain: String, payload: ByteArray): ByteArray {
        val s = Ed25519Signer()
        s.init(true, sk)
        val data = domain.toByteArray(Charsets.ISO_8859_1) + payload
        s.update(data, 0, data.size)
        return s.generateSignature()
    }

    private fun u16(v: Int) = byteArrayOf((v shr 8).toByte(), v.toByte())

    private fun mint(edition: Int, seats: Int, issuedDay: Int, expiresDay: Int, updatesDay: Int, offline: Boolean, label: String = ""): Pair<String, String> {
        val id = ByteArray(8) { (it + 9).toByte() }
        val lab = label.toByteArray()
        val payload = byteArrayOf(1, edition.toByte()) + u16(seats) + byteArrayOf(if (offline) 1 else 0) + u16(issuedDay) + u16(expiresDay) + u16(updatesDay) + id + byteArrayOf(lab.size.toByte()) + lab
        val sig = sign("DRIVEBAY-LICENSE-v1\u0000", payload)
        return "DBAY-" + LicenseCodec.b32Encode(payload + sig).chunked(5).joinToString("-") to id.joinToString("") { "%02x".format(it) }
    }

    private fun receipt(licenseIdHex: String, machineId: String, issued: Long, until: Long): String {
        val id = LicenseCodec.hexToBytes(licenseIdHex)
        val mh = MessageDigest.getInstance("SHA-256").digest(machineId.toByteArray()).copyOf(8)
        fun u32(v: Long) = byteArrayOf((v shr 24).toByte(), (v shr 16).toByte(), (v shr 8).toByte(), v.toByte())
        val payload = byteArrayOf(1) + id + mh + u32(issued) + u32(until)
        return "DBAR1." + java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(payload + sign("DRIVEBAY-RECEIPT-v1\u0000", payload))
    }

    private class MemStorage : LicenseStorage {
        var rec: LicenseRecord? = null
        override fun load() = rec
        override fun save(record: LicenseRecord) { rec = record }
        override fun clear() { rec = null }
    }

    private inner class FakeServer(val seats: Int) : LicenseHttp {
        val dayNum = ((now0 - LicenseCodec.LICENSE_EPOCH) / day).toInt()
        val minted = mint(2, seats, dayNum, 0, 0xFFFF, false)
        val devices = linkedMapOf<String, String>()
        var down = false
        var revoked = false
        val calls = mutableListOf<String>()
        override fun post(action: String, body: JSONObject): HttpReply {
            calls += action
            if (down) return HttpReply(0, null, network = true)
            val machine = body.optString("machineId")
            if (revoked) return HttpReply(403, JSONObject().put("error", "This license was revoked.").put("code", "revoked"))
            return when (action) {
                "activate", "refresh" -> {
                    if (machine !in devices && devices.size >= seats) {
                        HttpReply(409, JSONObject().put("error", "All seats are in use.").put("code", "seats_full").put("devices", JSONArray(devices.values.map { JSONObject().put("name", it) })))
                    } else {
                        devices[machine] = body.optString("name")
                        HttpReply(200, JSONObject().put("ok", true).put("licenseKey", minted.first).put("receipt", receipt(minted.second, machine, now0, now0 + 30 * day)))
                    }
                }
                "deactivate" -> HttpReply(200, JSONObject().put("ok", true).put("released", devices.remove(machine) != null))
                else -> HttpReply(400, JSONObject().put("error", "?"))
            }
        }
    }

    private fun manager(storage: LicenseStorage, http: LicenseHttp, machine: String, clock: () -> Long = { now0 + 5 }) =
        LicenseManager(storage, http, { machine }, { "Test phone" }, "3.39.0", now0, pk, clock)

    @Test
    fun freeByDefault() {
        val m = manager(MemStorage(), FakeServer(1), "phone-aaaaaaaa")
        assertEquals("free", m.state().edition)
        assertFalse(m.state().can("remote_access"))
    }

    @Test
    fun activateSeatLimitDeactivateAndRevoke() {
        val server = FakeServer(1)
        val s1 = MemStorage()
        val s2 = MemStorage()
        val a = manager(s1, server, "phone-aaaaaaaa")
        val r1 = a.activate("DBAY-0123-4567-89AB-CDEF".let { server.minted.first })
        assertTrue(r1.message, r1.ok)
        assertEquals("elite", a.state().edition)
        assertTrue(a.state().can("remote_24h"))
        val b = manager(s2, server, "phone-bbbbbbbb")
        val r2 = b.activate(server.minted.first)
        assertFalse(r2.ok)
        assertEquals("seats_full", r2.code)
        assertEquals(listOf("Test phone"), r2.devices)
        assertNull(s2.rec)
        assertTrue(a.deactivate().released)
        assertNull(s1.rec)
        assertTrue(b.activate(server.minted.first).ok)
        server.revoked = true
        assertFalse(b.refresh().ok)
        val st = b.state()
        assertEquals("free", st.edition)
        assertEquals("revoked", st.status)
    }

    @Test
    fun receiptForAnotherPhoneDoesNotUnlock() {
        val server = FakeServer(2)
        val s = MemStorage()
        manager(s, server, "phone-aaaaaaaa").activate(server.minted.first)
        val stolen = manager(s, server, "phone-cccccccc")
        assertEquals("free", stolen.state().edition)
        assertEquals("needs_online", stolen.state().status)
    }

    @Test
    fun networkTroubleKeepsLicenseAndReceiptLapsesAfterThirtyDays() {
        val server = FakeServer(1)
        val s = MemStorage()
        var t = now0 + 5
        val m = manager(s, server, "phone-dddddddd") { t }
        assertTrue(m.activate(server.minted.first).ok)
        server.down = true
        assertEquals("network", m.refresh().code)
        assertEquals("elite", m.state().edition)
        assertEquals("network", m.deactivate(false).code)
        t = now0 + 31 * day
        assertEquals("free", m.state(t).edition)
        assertTrue(m.state(t).needsRefresh)
        assertTrue(m.deactivate(true).ok)
        assertNull(s.rec)
    }

    @Test
    fun offlineKeyNeedsNoServerAndExpiredOrForgedKeysAreRefused() {
        val server = FakeServer(1)
        server.down = true
        val dayNum = ((now0 - LicenseCodec.LICENSE_EPOCH) / day).toInt()
        val (offlineKey, _) = mint(3, 250, dayNum, 0, 0xFFFF, true, "Acme Corp")
        val s = MemStorage()
        val m = manager(s, server, "airgapped-host-1")
        val out = m.activate(offlineKey)
        assertTrue(out.message, out.ok)
        assertTrue(out.offline)
        assertEquals("enterprise", m.state().edition)
        assertEquals("Acme Corp", m.state().license?.label)
        assertEquals(0, server.calls.size)
        val (expiredKey, _) = mint(1, 1, dayNum - 100, dayNum - 50, dayNum - 50, false)
        assertEquals("expired", manager(MemStorage(), server, "x-machine-0001").activate(expiredKey).code)
        assertEquals("format", manager(MemStorage(), server, "x-machine-0001").activate("hello").code)
        val raw = LicenseCodec.b32Decode(offlineKey.substring(4))!!
        raw[1] = 1
        val forged = "DBAY-" + LicenseCodec.b32Encode(raw).chunked(5).joinToString("-")
        assertEquals("bad_signature", manager(MemStorage(), server, "x-machine-0001").activate(forged).code)
    }
}
