package com.lordstryfe.drivebay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneLinkApiTest {
    private val token = "db_" + "ab".repeat(32)
    private val hash = PhoneShareAuth.hash(token)

    @Test fun forgetWithBearerTokenDropsThePair() {
        val dir = MemoryPairs(mutableListOf(PhonePair(hash, "Mac Mini", hash, null, 0, 0, scope = "full", machineId = "mac-1")))
        var forgotten = ""
        val response = PhoneLinkApi.handle(
            "POST",
            "/api/link/forget",
            mapOf("authorization" to "Bearer $token"),
            ByteArray(0),
            "100.64.0.2",
            dir,
            { forgotten = it },
        )!!
        assertEquals(200, response.status)
        assertTrue(dir.snapshot().isEmpty())
        assertEquals("mac-1", forgotten)
    }

    @Test fun forgetFromThePublicInternetIsRejected() {
        val dir = MemoryPairs(mutableListOf(PhonePair(hash, "Mac Mini", hash, null, 0, 0, scope = "full", machineId = "mac-1")))
        val response = PhoneLinkApi.handle("POST", "/api/link/forget", mapOf("authorization" to "Bearer $token"), ByteArray(0), "8.8.8.8", dir, {})!!
        assertEquals(403, response.status)
        assertEquals(1, dir.snapshot().size)
    }

    @Test fun unknownLinkMethodsAreIgnored() {
        assertNull(PhoneLinkApi.handle("GET", "/api/link/forget", emptyMap(), ByteArray(0), "10.0.0.2", null, {}))
        val reciprocal = PhoneLinkApi.handle("POST", "/api/link/reciprocal", emptyMap(), ByteArray(0), "10.0.0.2", null, {})
        assertEquals(403, reciprocal!!.status)
    }

    @Test fun alreadyTrustedJoinIsAutoGrantedAndPollReturnsAToken() {
        val dek = MesaVault.fromB64("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=")
        val selfId = "phone-1978c6ebc8c04036"
        val fromId = "pc-joining-00000004"
        val secret = "dbp_" + "ab".repeat(32)
        MesaSponsor.testDek = dek
        MesaSponsor.testSelfId = selfId
        val dir = MemoryPairs(mutableListOf(PhonePair(token, "PC", hash, null, 0, 0, scope = "full", machineId = fromId)))
        val proof = MesaJoin.proof(dek, selfId, fromId, secret)
        val payload = org.json.JSONObject()
            .put("machineId", fromId)
            .put("displayName", "DESKTOP-7OPHOTR")
            .put("secret", secret)
            .put("proof", proof)
            .put("signature", "c2tpcA==")
        val asked = PhoneLinkApi.handle(
            "POST",
            "/api/link/request",
            mapOf(),
            payload.toString().toByteArray(),
            "192.168.0.10",
            dir,
            {},
        )!!
        assertEquals(200, asked.status)
        val askedBody = org.json.JSONObject(asked.body.toString(Charsets.UTF_8))
        assertEquals(true, askedBody.optBoolean("granted"))
        val polled = PhoneLinkApi.handle(
            "POST",
            "/api/link/poll",
            mapOf(),
            org.json.JSONObject().put("id", askedBody.optString("id")).put("secret", secret).toString().toByteArray(),
            "192.168.0.10",
            dir,
            {},
        )!!
        assertEquals(200, polled.status)
        val pollBody = org.json.JSONObject(polled.body.toString(Charsets.UTF_8))
        assertEquals("full", pollBody.optString("scope"))
        assertTrue(pollBody.optString("token").startsWith("db_"))
        MesaSponsor.testDek = null
        MesaSponsor.testSelfId = null
    }

    private class MemoryPairs(private var items: MutableList<PhonePair>) : PhonePairDirectory {
        override fun snapshot(): List<PhonePair> = items.toList()
        override fun save(pairs: List<PhonePair>) {
            items = pairs.toMutableList()
        }
    }
}
