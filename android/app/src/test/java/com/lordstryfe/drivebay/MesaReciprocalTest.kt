package com.lordstryfe.drivebay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MesaReciprocalTest {
    @Test fun trustedPairIdIsStableHex() {
        val id = MesaReciprocal.trustedPairId("host-machine-0001")
        assertEquals(64, id.length)
        assertTrue(id.matches(Regex("^[0-9a-f]{64}$")))
        assertEquals(id, MesaReciprocal.trustedPairId("host-machine-0001"))
        assertFalse(id == MesaReciprocal.trustedPairId("other-host"))
    }

    @Test fun looksLikeInboundAcceptsDesktopAndPhoneTokens() {
        val phone = "db_" + "ab".repeat(32)
        val desktop = "dbp_" + "cd".repeat(32)
        assertTrue(MesaReciprocal.looksLikeInbound(phone))
        assertTrue(MesaReciprocal.looksLikeInbound(desktop))
        assertFalse(MesaReciprocal.looksLikeInbound("db_short"))
        assertFalse(MesaReciprocal.looksLikeInbound(""))
    }

    @Test fun offerPayloadCarriesADeviceKeySignature() {
        val token = "db_" + "ab".repeat(32)
        val issuedAt = "2026-11-17T19:02:00.000Z"
        val key = "MC4CAQAwBQYDK2VwBCIEICmwJa9gLiF5bAd804u9pR4rrqttxL8hNpffgGULaPQB"
        val body = MesaReciprocal.offerPayload(key, "host-machine-0001", "phone-1978c6ebc8c04036", token, issuedAt)
        assertEquals("BTmJcdS9V0fYbJWkmR3tbozlY3JBOcg8zj/aoFu82QbPYitUQS+KJzTyCBPz4u6XB4u+c8xLsbdNPBncmd+yCg==", body.getString("signature"))
        assertEquals(token, body.getJSONObject("offer").getString("accessToken"))
        assertEquals("host-machine-0001", body.getJSONObject("offer").getString("hostId"))
    }
}
