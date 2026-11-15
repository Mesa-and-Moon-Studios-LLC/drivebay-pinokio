package com.lordstryfe.drivebay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MesaCloudTest {
    @Test fun registrationIsConnectionInfoOnly() {
        val body = MesaCloud.registration(
            "phone-12345678",
            "Pixel",
            "100.64.0.4",
            "192.168.1.8",
            8780,
            "A".repeat(32),
            "2026-10-22T12:00:00Z",
            hidden = true,
            directInternet = false,
            publicHost = "203.0.113.5",
        )
        assertEquals(MesaCloud.cloudKeys.toSet(), body.keys().asSequence().toSet())
        assertEquals("", body.getString("publicHost"))
        assertEquals("phone", body.getString("type"))
        assertTrue(body.getBoolean("hidden"))
    }

    @Test fun connectionPrefersTailscale() {
        val machine = org.json.JSONObject()
            .put("type", "pc")
            .put("port", 8765)
            .put("tailscaleHost", "100.64.0.8")
            .put("lanAddress", "192.168.1.2")
            .put("directInternet", true)
            .put("publicHost", "203.0.113.5")
        assertEquals("http://100.64.0.8:8765/dav/", MesaCloud.connectionUrl(machine))
        assertFalse(MesaCloud.usesPublicInternet(machine))
        machine.put("tailscaleHost", "")
        machine.put("lanAddress", "")
        assertTrue(MesaCloud.usesPublicInternet(machine))
        assertEquals("http://203.0.113.5:8765/dav/", MesaCloud.connectionUrl(machine))
    }

    @Test fun signInUrlsAndShareNames() {
        val google = MesaCloud.googleAuthorizeUrl("client", "drivebay://mesa", "n1")
        assertTrue(google.startsWith("https://accounts.google.com/"))
        assertTrue(google.contains("state=google.n1") || google.contains("state=google%2En1") || google.contains("google."))
        val parsed = MesaCloud.readFragment("drivebay://mesa#id_token=abc&state=apple.n2")
        assertEquals("apple", parsed?.first)
        assertEquals(listOf("Photos"), MesaCloud.shareNames(
            "<d:displayname>Drivebay</d:displayname><d:displayname>Photos</d:displayname>",
        ))
        val (tailscale, lan) = MesaCloud.classify(listOf("8.8.8.8", "192.168.0.5", "100.80.1.1"))
        assertEquals("100.80.1.1", tailscale)
        assertEquals("192.168.0.5", lan)
    }

    @Test fun emailUsesTheSameProjectAndDoesNotKeepThePassword() {
        val config = MesaCloud.parseConfig(
            """{"apiKey":"key","authDomain":"mesa.firebaseapp.com","projectId":"mesa","cloudApi":"https://mesaandmoon.com/drivebay/api","authEmulator":"https://evil.example"}"""
        )!!
        assertTrue(config.ready)
        assertEquals("", config.authEmulator)
        assertTrue(MesaCloud.emailAuthUrl(config, "signIn").startsWith("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword"))
        val local = MesaCloud.parseConfig(
            """{"apiKey":"key","projectId":"mesa","cloudApi":"http://127.0.0.1:9","authEmulator":"http://127.0.0.1:9099"}"""
        )!!
        assertTrue(MesaCloud.emailAuthUrl(local, "signUp").startsWith("http://127.0.0.1:9099/identitytoolkit.googleapis.com/"))
        val body = MesaCloud.emailAuthBody("signIn", "Ada@Example.com", "correct horse")
        assertTrue(body.contains("ada@example.com"))
        val session = MesaCloud.emailSession(org.json.JSONObject(body).put("idToken", "id").put("refreshToken", "refresh"))
        assertEquals("id", session?.first)
        assertEquals("refresh", session?.third)
        assertFalse(session.toString().contains("correct horse") && session?.second == "correct horse")
        assertTrue(MesaCloud.providerConflictMessage(listOf("google.com")).contains("Google"))
        assertEquals("Phone%20Name", PhoneShareLifecycle.phoneNameHeader("Phone Name"))
    }
}
