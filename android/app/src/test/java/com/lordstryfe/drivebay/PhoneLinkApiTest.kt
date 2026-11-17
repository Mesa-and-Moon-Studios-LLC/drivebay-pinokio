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
        assertNull(PhoneLinkApi.handle("POST", "/api/link/reciprocal", emptyMap(), ByteArray(0), "10.0.0.2", null, {}))
    }

    private class MemoryPairs(private var items: MutableList<PhonePair>) : PhonePairDirectory {
        override fun snapshot(): List<PhonePair> = items.toList()
        override fun save(pairs: List<PhonePair>) {
            items = pairs.toMutableList()
        }
    }
}
