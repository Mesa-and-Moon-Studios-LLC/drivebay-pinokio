package com.mesaandmoon.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdatePolicyTest {
    private val cfg = VersionConfig(minVersionCode = 20, latestVersionCode = 22, message = "Please update")

    private fun decide(installed: Long, c: VersionConfig? = cfg, play: Boolean = true, imm: Boolean = true, flex: Boolean = true) =
        UpdatePolicy.decide(installed, c, play, imm, flex)

    @Test fun parsesSharedFormat() {
        val c = UpdatePolicy.parse("""{"minVersionCode":33304,"latestVersionCode":33305,"message":" Hi "}""")!!
        assertEquals(33304L, c.minVersionCode)
        assertEquals(33305L, c.latestVersionCode)
        assertEquals("Hi", c.message)
    }

    @Test fun parsesCipherVaultLegacyFile() {
        val c = UpdatePolicy.parse("""{"latestVersionCode":20,"minVersionCode":20,"blockUnknownAndroid":false,"forceBody":"Needs an update"}""")!!
        assertEquals(20L, c.minVersionCode)
        assertEquals("Needs an update", c.message)
    }

    @Test fun latestNeverBelowMin() {
        val c = UpdatePolicy.parse("""{"minVersionCode":30,"latestVersionCode":10}""")!!
        assertEquals(30L, c.latestVersionCode)
        assertNull(c.message)
    }

    @Test fun badFilesFailOpen() {
        assertNull(UpdatePolicy.parse(null))
        assertNull(UpdatePolicy.parse(""))
        assertNull(UpdatePolicy.parse("<html>404</html>"))
        assertNull(UpdatePolicy.parse("""{"other":1}"""))
        assertNull(UpdatePolicy.parse("[1,2]"))
        assertNull(UpdatePolicy.parse("{" + " ".repeat(UpdatePolicy.MAX_BYTES) + "}"))
    }

    @Test fun belowMinIsRequired() = assertEquals(UpdateAction.REQUIRED, decide(19))

    @Test fun betweenMinAndLatestIsOptional() = assertEquals(UpdateAction.OPTIONAL, decide(21))

    @Test fun upToDateIsNone() {
        assertEquals(UpdateAction.NONE, decide(22))
        assertEquals(UpdateAction.NONE, decide(99))
    }

    @Test fun offlineOrMissingFileFailsOpen() = assertEquals(UpdateAction.NONE, decide(1, c = null))

    @Test fun noPlayUpdateFailsOpen() = assertEquals(UpdateAction.NONE, decide(1, play = false))

    @Test fun requiredFallsBackToOptionalWhenImmediateNotAllowed() =
        assertEquals(UpdateAction.OPTIONAL, decide(19, imm = false))

    @Test fun nothingWhenNoFlowAllowed() = assertEquals(UpdateAction.NONE, decide(19, imm = false, flex = false))

    @Test fun currentFilesForceNothing() {
        // version.json ships with min = latest = current build, so the current build is never prompted.
        val c = VersionConfig(33304, 33304, null)
        assertEquals(UpdateAction.NONE, UpdatePolicy.decide(33304, c, true, true, true))
    }

    @Test fun onlyPlayStoreInstallsCount() {
        assertTrue(UpdatePolicy.isPlayInstaller("com.android.vending"))
        assertFalse(UpdatePolicy.isPlayInstaller(null))
        assertFalse(UpdatePolicy.isPlayInstaller("com.google.android.packageinstaller"))
        assertFalse(UpdatePolicy.isPlayInstaller("com.amazon.venezia"))
    }
}
