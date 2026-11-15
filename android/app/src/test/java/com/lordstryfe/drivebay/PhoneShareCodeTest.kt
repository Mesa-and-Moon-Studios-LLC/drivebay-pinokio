package com.lordstryfe.drivebay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.SecureRandom
import java.util.Properties

class PhoneShareCodeTest {
    private val token = "db_" + "ab".repeat(32)
    private val tokenHash = PhoneShareAuth.hash(token)
    private fun basic(secret: String, user: String = PhoneShareAuth.USER) = PhoneShareAuth.basicHeader(user, secret)

    /** SecureRandom that returns a fixed int, to prove zero-padding. */
    private class FixedRandom(private val value: Int) : SecureRandom() {
        override fun nextInt(bound: Int): Int = value
    }

    @Test fun generatesSixZeroPaddedDigits() {
        assertEquals("000042", PhoneShareCode.generate(FixedRandom(42)))
        assertEquals("999999", PhoneShareCode.generate(FixedRandom(999_999)))
        repeat(200) {
            val code = PhoneShareCode.generate()
            assertTrue(code, PhoneShareCode.looksLikeCode(code))
        }
        assertFalse(PhoneShareCode.looksLikeCode("12345"))
        assertFalse(PhoneShareCode.looksLikeCode("1234567"))
        assertFalse(PhoneShareCode.looksLikeCode("12a456"))
    }

    @Test fun hashIsSaltedAndNeverPlain() {
        val a = PhoneShareCode.hash("123456")
        val b = PhoneShareCode.hash("123456")
        assertNotEquals(a, b) // different salts
        assertFalse(a.contains("123456"))
        assertTrue(a.startsWith("pbkdf2-sha256$"))
        assertTrue(PhoneShareCode.matches("123456", a))
        assertTrue(PhoneShareCode.matches("123456", b))
        assertFalse(PhoneShareCode.matches("123457", a))
        assertFalse(PhoneShareCode.matches("12345", a))
        assertFalse(PhoneShareCode.matches("123456", null))
        assertFalse(PhoneShareCode.matches("123456", "pbkdf2-sha256\$1\$zz\$zz"))
        assertFalse(PhoneShareCode.matches("123456", "sha1$1$00$00"))
    }

    @Test fun codeRangesOnlyTailscaleAndPrivate() {
        listOf(
            "100.64.0.1", "100.70.170.22", "100.127.255.254", "10.0.0.5", "172.16.0.1", "172.31.255.1",
            "192.168.1.20", "169.254.3.4", "127.0.0.1", "::1", "fd7a:115c:a1e0::1", "fd7a:115c:a1e0:ab12:4843:cd96:6258:b240",
            "fe80::1%wlan0", "::ffff:192.168.1.2",
        ).forEach { assertTrue(it, PhoneShareCode.allowedFrom(it)) }
        listOf(
            "100.63.255.255", "100.128.0.1", "172.15.0.1", "172.32.0.1", "8.8.8.8", "1.1.1.1", "192.169.0.1",
            "2001:db8::1", "2607:f8b0::1", "::ffff:8.8.8.8", "", null, "not-an-ip",
        ).forEach { assertFalse(it.toString(), PhoneShareCode.allowedFrom(it)) }
    }

    @Test fun acceptsTokenOrCodeAndRejectsTheRest() {
        val state = MemoryCodeState(PhoneShareCode.hash("004211"))
        val gate = PhoneShareGate(tokenHash, state)
        val lan = "100.70.170.22"
        assertTrue(gate.authorized(basic(token), lan))
        assertTrue(gate.authorized(basic("004211"), lan))
        assertTrue(gate.authorized(basic("004211"), lan)) // cached path
        assertTrue(gate.authorized(basic("004211", "DriveBay"), lan))
        assertFalse(gate.authorized(basic("004211", "admin"), lan))
        assertFalse(gate.authorized(basic("db_" + "cd".repeat(32)), lan))
        assertFalse(gate.authorized(null, lan))
        assertFalse(gate.authorized("Bearer x", lan))
        assertEquals(0, state.codeFailures()) // wrong token is not a code strike
        // Public address: code refused and not counted; token still works.
        assertFalse(gate.authorized(basic("004211"), "8.8.8.8"))
        assertFalse(gate.authorized(basic("000000"), "8.8.8.8"))
        assertEquals(0, state.codeFailures())
        assertTrue(gate.authorized(basic(token), "8.8.8.8"))
        // No code stored: only the token works.
        val noCode = PhoneShareGate(tokenHash, MemoryCodeState())
        assertFalse(noCode.authorized(basic("004211"), lan))
        assertTrue(noCode.authorized(basic(token), lan))
    }

    @Test fun davProtocolUsesTheConnectionAddress() {
        val gate = PhoneShareGate(tokenHash, MemoryCodeState(PhoneShareCode.hash("135790")))
        val store = MemoryDavStore()
        fun propfind(remote: String) = DavProtocol.handle(
            DavRequest("PROPFIND", "/", mapOf("Authorization" to basic("135790"), "Depth" to "0"), remoteAddress = remote),
            store,
            gate,
        ).status
        assertEquals(207, propfind("192.168.1.9"))
        assertEquals(401, propfind("203.0.113.7"))
    }

    @Test fun fiveWrongCodesLockOnlyTheCode() {
        val state = MemoryCodeState(PhoneShareCode.hash("246810"))
        var lockedCalls = 0
        val gate = PhoneShareGate(tokenHash, state) { lockedCalls++ }
        // Spread across addresses: the count is global, not per IP.
        val ips = listOf("100.64.0.2", "192.168.1.3", "10.0.0.4", "100.70.170.22", "172.16.5.5")
        ips.forEachIndexed { i, ip ->
            assertFalse(gate.authorized(basic("11111$i"), ip))
            assertEquals(i + 1, state.codeFailures())
        }
        assertEquals(1, lockedCalls)
        assertFalse(gate.authorized(basic("246810"), "100.64.0.2"))
        assertEquals(5, state.codeFailures())
        assertTrue(gate.authorized(basic(token), "100.64.0.2"))
    }

    @Test fun lockoutSurvivesRestart() {
        val file = File.createTempFile("drivebay-code", ".properties").apply { deleteOnExit() }
        class FileState : PhoneShareCodeState {
            private fun load() = Properties().apply { if (file.length() > 0) file.inputStream().use { load(it) } }
            private fun store(p: Properties) = file.outputStream().use { p.store(it, null) }
            override fun codeRecord(): String? = load().getProperty("code")
            override fun codeFailures(): Int = load().getProperty("failures")?.toInt() ?: 0
            override fun saveCodeFailures(count: Int) = store(load().apply { setProperty("failures", count.toString()) })
            override fun saveCode(record: String?, failures: Int) = store(load().apply {
                if (record == null) remove("code") else setProperty("code", record)
                setProperty("failures", failures.toString())
            })
        }
        FileState().saveCode(PhoneShareCode.hash("975310"), 0)
        val first = PhoneShareGate(tokenHash, FileState())
        repeat(3) { assertFalse(first.authorized(basic("000001"), "10.0.0.2")) }
        // "Restart": new gate, new state object, same file.
        val second = PhoneShareGate(tokenHash, FileState())
        assertEquals(3, FileState().codeFailures())
        assertFalse(second.authorized(basic("000002"), "10.0.0.2"))
        assertFalse(second.authorized(basic("000003"), "10.0.0.2"))
        val third = PhoneShareGate(tokenHash, FileState())
        assertFalse(third.authorized(basic("975310"), "10.0.0.2")) // locked even with the right code
        assertTrue(third.authorized(basic(token), "10.0.0.2"))
        // New token = new code record with a fresh count.
        FileState().saveCode(PhoneShareCode.hash("864200"), 0)
        assertTrue(PhoneShareGate(tokenHash, FileState()).authorized(basic("864200"), "10.0.0.2"))
    }

    @Test fun clearingRemovesTheCode() {
        val state = MemoryCodeState(PhoneShareCode.hash("112233"))
        val gate = PhoneShareGate(tokenHash, state)
        assertTrue(gate.authorized(basic("112233"), "192.168.0.8"))
        state.saveCode(null, 0)
        assertFalse(gate.authorized(basic("112233"), "192.168.0.8")) // cache doesn't outlive the record
        assertTrue(gate.authorized(basic(token), "192.168.0.8"))
    }

    @Test fun phoneStoreClearsCodeOnOffAndNewToken() {
        // PhoneShareStore needs Android prefs, so check its source for the clearing rules.
        val src = File("src/main/java/com/lordstryfe/drivebay/PhoneShareStore.kt").readText()
        val setEnabled = src.substringAfter("fun setEnabled(value: Boolean)").substringBefore("override fun codeRecord")
        assertTrue(setEnabled.contains("if (!value) edit.remove(KEY_CODE).remove(KEY_CODE_FAILURES)"))
        val creds = src.substringAfter("fun setCredentials(").substringBefore("companion object")
        assertTrue(creds.contains("putString(KEY_CODE, codeRecord)"))
        assertTrue(creds.contains("putInt(KEY_CODE_FAILURES, 0)"))
        assertTrue(src.contains("prefs.edit().putInt(KEY_CODE_FAILURES, count).commit()"))
        val activity = File("src/main/java/com/lordstryfe/drivebay/MainActivity.kt").readText()
        assertTrue(activity.contains("phoneShare.addPair(name, PhoneShareAuth.hash(token), PhoneShareCode.hash(code))"))
        assertFalse(activity.contains("putString(\"code\""))
    }
}
