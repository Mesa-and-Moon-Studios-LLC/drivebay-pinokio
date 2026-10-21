package com.lordstryfe.drivebay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneSharePairsTest {
    private val tokenA = "db_" + "ab".repeat(32)
    private val tokenB = "db_" + "cd".repeat(32)
    private val codeA = "111111"
    private val codeB = "222222"

    @Test fun twoPcsAuthorizeTogetherAndACodeHitDoesNotStrikeTheOther() {
        val dir = MemoryPairDirectory(listOf(pair("Kitchen", tokenA, codeA), pair("Office", tokenB, codeB)))
        val gate = PhonePairGate(dir, now = { 5_000 })
        assertTrue(gate.authorized(basic(tokenA), "8.8.8.8"))
        assertTrue(gate.authorized(basic(tokenB), "1.1.1.1"))
        assertTrue(gate.authorized(basic(codeA), "10.0.0.2"))
        assertEquals(0, failures(dir, tokenB))
        assertEquals(5_000L, dir.snapshot().first { it.tokenHash == PhoneShareAuth.hash(tokenA) }.lastSeenMs)
    }

    @Test fun oneWrongCodeLocksOnlyTheCodeThatWasAlreadyNearTheLimit() {
        val near = pair("Kitchen", tokenA, codeA).copy(codeFailures = 4)
        val fresh = pair("Office", tokenB, codeB)
        val dir = MemoryPairDirectory(listOf(near, fresh))
        val locked = mutableListOf<String>()
        val gate = PhonePairGate(dir, onCodeLocked = { locked += it })
        assertFalse(gate.authorized(basic("000000"), "192.168.1.4"))
        assertEquals(5, failures(dir, tokenA))
        assertEquals(1, failures(dir, tokenB))
        assertEquals(listOf(PhoneShareAuth.hash(tokenA)), locked)
        assertFalse(gate.authorized(basic(codeA), "192.168.1.4"))
        assertTrue(gate.authorized(basic(codeB), "192.168.1.4"))
        assertTrue(gate.authorized(basic(tokenA), "192.168.1.4"))
        assertTrue(gate.authorized(basic(tokenB), "192.168.1.4"))
        assertEquals(1, failures(dir, tokenB))
    }

    @Test fun fiveMissesLockEveryActiveCodeAndLeaveTheTokens() {
        val dir = MemoryPairDirectory(listOf(pair("Kitchen", tokenA, codeA), pair("Office", tokenB, codeB)))
        val gate = PhonePairGate(dir)
        repeat(5) { assertFalse(gate.authorized(basic("999999"), "10.1.1.1")) }
        assertEquals(5, failures(dir, tokenA))
        assertEquals(5, failures(dir, tokenB))
        assertFalse(gate.authorized(basic(codeA), "10.1.1.1"))
        assertFalse(gate.authorized(basic(codeB), "10.1.1.1"))
        assertTrue(gate.authorized(basic(tokenA), "10.1.1.1"))
        assertTrue(gate.authorized(basic(tokenB), "10.1.1.1"))
    }

    @Test fun aPublicAddressDoesNotSpendACodeTry() {
        val dir = MemoryPairDirectory(listOf(pair("Kitchen", tokenA, codeA)))
        val gate = PhonePairGate(dir)
        assertFalse(gate.authorized(basic(codeA), "8.8.8.8"))
        assertEquals(0, failures(dir, tokenA))
        assertFalse(gate.authorized(basic("not-a-code"), "10.0.0.2"))
        assertEquals(0, failures(dir, tokenA))
    }

    @Test fun revokeDropsThatPcImmediately() {
        val dir = MemoryPairDirectory(listOf(pair("Kitchen", tokenA, codeA), pair("Office", tokenB, codeB)))
        val gate = PhonePairGate(dir, now = { 9_000 })
        assertTrue(gate.authorized(basic(tokenA), "10.0.0.2"))
        dir.save(PhonePairRules.revoke(dir.snapshot(), PhoneShareAuth.hash(tokenA)))
        assertFalse(gate.authorized(basic(tokenA), "10.0.0.2"))
        assertFalse(gate.authorized(basic(codeA), "10.0.0.2"))
        assertTrue(gate.authorized(basic(tokenB), "10.0.0.2"))
        val response = DavProtocol.handle(
            DavRequest("PROPFIND", "/", mapOf("Authorization" to basic(tokenB)), remoteAddress = "10.0.0.2"),
            MemoryDavStore(),
            gate,
            PhoneShareLifecycle.peerHeader(PhonePairRules.peerIds(dir.snapshot())),
        )
        assertEquals(207, response.status)
        assertEquals(PhoneShareLifecycle.peerId(PhoneShareAuth.hash(tokenB)), response.headers[PhoneShareLifecycle.CLIENT_HEADER])
    }

    @Test fun legacySinglePairingBecomesTheFirstEntry() {
        val hash = PhoneShareAuth.hash(tokenA)
        val code = codeHash(codeA)
        val once = PhonePairRules.migrate(emptyList(), hash, code, 3)
        assertEquals(1, once.size)
        assertEquals("This PC", once[0].name)
        assertEquals(hash, once[0].id)
        assertEquals(hash, once[0].tokenHash)
        assertEquals(code, once[0].codeRecord)
        assertEquals(3, once[0].codeFailures)
        assertEquals(once, PhonePairRules.migrate(once, "ab".repeat(32), null, 0))
        assertTrue(PhonePairRules.migrate(emptyList(), "not-a-hash", code, 1).isEmpty())
        val encoded = PhonePairJson.encode(once)
        assertFalse(encoded.contains(tokenA))
        assertEquals(once, PhonePairJson.decode(encoded))
    }

    @Test fun ownerPasswordIsHashedAndDoesNotBlockAShareThatIsAlreadyOn() {
        assertFalse(PhoneOwnerPassword.acceptable("short"))
        assertFalse(PhoneOwnerPassword.acceptable("has\nnewline"))
        val password = "correct-horse"
        val record = PhoneOwnerPassword.hash(password)
        assertFalse(record.contains(password))
        assertTrue(record.startsWith("pbkdf2-sha256$"))
        assertTrue(PhoneOwnerPassword.matches(password, record))
        assertFalse(PhoneOwnerPassword.matches("other-horse", record))
        assertTrue(PhoneOwnerPassword.sharingAllowed(record, null, alreadyEnabled = true))
        assertFalse(PhoneOwnerPassword.sharingAllowed(null, password, alreadyEnabled = false))
        assertFalse(PhoneOwnerPassword.sharingAllowed(record, "other-horse", alreadyEnabled = false))
        assertTrue(PhoneOwnerPassword.sharingAllowed(record, password, alreadyEnabled = false))
        assertTrue(PhoneOwnerPassword.manageAllowed(record, password))
        assertFalse(PhoneOwnerPassword.manageAllowed(record, "other-horse"))
    }

    @Test fun lastSeenIsThrottledAndLabeled() {
        val id = PhoneShareAuth.hash(tokenA)
        val start = listOf(pair("Kitchen", tokenA, codeA))
        val seen = PhonePairRules.touch(start, id, 10_000)
        assertEquals(10_000L, seen[0].lastSeenMs)
        val soon = PhonePairRules.touch(seen, id, 40_000)
        assertSame(seen, soon)
        val later = PhonePairRules.touch(seen, id, 80_000)
        assertNotSame(seen, later)
        assertEquals(80_000L, later[0].lastSeenMs)
        assertEquals("Not yet", PhonePairRules.lastSeenLabel(0, 80_000))
        assertEquals("Just now", PhonePairRules.lastSeenLabel(80_000, 90_000))
        assertEquals("1 min ago", PhonePairRules.lastSeenLabel(1, 61_000))
        assertEquals("2 min ago", PhonePairRules.lastSeenLabel(1, 121_000))
        assertEquals("1 h ago", PhonePairRules.lastSeenLabel(1, 3_600_001))
        assertEquals("2 h ago", PhonePairRules.lastSeenLabel(1, 7_200_001))
        val made = PhonePairRules.create("Kitchen\nPC", tokenA, codeA)
        assertEquals("Kitchen PC", made.name)
        assertEquals(0L, made.lastSeenMs)
        assertFalse(made.tokenHash.contains(tokenA))
        assertNull(PhonePairJson.decode("{").firstOrNull())
    }

    @Test fun aNewPairKeepsTheOldOneAndABlankNameBecomesTheHostname() {
        val home = pair("Home", tokenA, codeA).copy(name = "Home PC", customName = true)
        val work = pair("Work", tokenB, codeB).copy(name = "", customName = false)
        val both = PhonePairRules.append(listOf(home), work)
        assertEquals(listOf("Home PC", ""), both.map { it.name })
        assertSame(both, PhonePairRules.append(both, work))
        val named = PhonePairRules.applyHostName(both, work.id, " OFFICE-PC\n", 2_000)
        assertEquals(listOf("Home PC", "OFFICE-PC"), named!!.map { it.name })
        assertEquals("Home PC", PhonePairRules.applyHostName(named, home.id, "OTHER", 3_000)?.get(0)?.name ?: named[0].name)
        val renamed = PhonePairRules.rename(named, work.id, "Work PC")
        assertEquals("Work PC", renamed!![1].name)
        assertTrue(renamed[1].customName)
        assertEquals(null, PhonePairRules.applyHostName(renamed, work.id, "OFFICE-PC", 4_000))
        val dir = MemoryPairDirectory(listOf(work))
        val gate = PhonePairGate(dir, now = { 8_000 })
        gate.rememberClientName("Home-PC")
        assertTrue(gate.authorized(basic(tokenB), "10.0.0.4"))
        assertEquals("Home-PC", dir.snapshot().single().name)
        assertEquals(listOf(work.id), dir.snapshot().map { it.id })
    }

    @Test fun discoveryNamesEveryPairedPc() {
        val ids = listOf(PhoneShareLifecycle.peerId(PhoneShareAuth.hash(tokenA))!!, PhoneShareLifecycle.peerId(PhoneShareAuth.hash(tokenB))!!)
        assertEquals("${ids[0]},${ids[1]}", PhoneShareLifecycle.peerHeader(ids + ids[0]))
        val messages = PhoneShareLifecycle.discoveryMessages(ids, 8780)
        assertEquals(2, messages.size)
        assertEquals("DRIVEBAY1 ${ids[0]} 8780", messages[0])
        assertEquals("DRIVEBAY1 ${ids[1]} 8780", messages[1])
        assertEquals(3, messages[0].split(" ").size)
        val pairs = listOf(pair("Kitchen", tokenA, codeA))
        assertTrue(PhoneShareLifecycle.shouldResume(true, pairs, 1))
        assertTrue(PhoneShareLifecycle.shouldResume(true, pairs, 0, wholePhone = true))
        assertFalse(PhoneShareLifecycle.shouldResume(true, emptyList(), 1))
        assertFalse(PhoneShareLifecycle.shouldResume(false, pairs, 1))
    }

    private fun pair(name: String, token: String, code: String): PhonePair {
        val hash = PhoneShareAuth.hash(token)
        return PhonePair(hash, name, hash, codeHash(code), 0, 0)
    }

    private fun codeHash(code: String) = PhoneShareCode.hash(code, iterations = 1)

    private fun failures(dir: PhonePairDirectory, token: String): Int =
        dir.snapshot().first { it.tokenHash == PhoneShareAuth.hash(token) }.codeFailures

    private fun basic(secret: String) = PhoneShareAuth.basicHeader(PhoneShareAuth.USER, secret)
}
