package com.lordstryfe.drivebay.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateVersionsTest {
    @Test fun newerVersionCodeOnly() {
        assertTrue(UpdateVersions.isNewerVersion(33404, 33405))
        assertFalse(UpdateVersions.isNewerVersion(33405, 33405))
        assertFalse(UpdateVersions.isNewerVersion(33406, 33405))
        assertFalse(UpdateVersions.isNewerVersion(33404, 0))
        assertFalse(UpdateVersions.isNewerVersion(33404, -1))
    }

    @Test fun packsAndroidVersionName() {
        assertEquals(33405L, UpdateVersions.packVersionName("3.34.5"))
        assertEquals(33405L, UpdateVersions.packVersionName("drivebay-3.34.5.apk"))
        assertEquals(33404L, UpdateVersions.packVersionName("Drivebay 3.34.4"))
        assertEquals(33603L, UpdateVersions.packVersionName("3.36.3-extra"))
        assertNull(UpdateVersions.packVersionName("3.36"))
        assertNull(UpdateVersions.packVersionName("no-version"))
    }

    @Test fun readsVersionCodeFromApkName() {
        assertEquals(33405L, UpdateVersions.versionCodeFromApkName("drivebay-3.34.5.apk"))
        assertEquals(33406L, UpdateVersions.versionCodeFromApkName("drivebay-33406.apk"))
        assertEquals(33407L, UpdateVersions.versionCodeFromApkName("drivebay-versionCode-33407.apk"))
        assertNull(UpdateVersions.versionCodeFromApkName("app-release.apk"))
    }

    @Test fun twelveHourThrottle() {
        val start = 1_700_000_000_000L
        assertTrue(UpdateVersions.shouldCheck(0L, start, force = false))
        assertFalse(UpdateVersions.shouldCheck(start, start + UpdateVersions.CHECK_INTERVAL_MS - 1, force = false))
        assertTrue(UpdateVersions.shouldCheck(start, start + UpdateVersions.CHECK_INTERVAL_MS, force = false))
        assertTrue(UpdateVersions.shouldCheck(start, start + 1, force = true))
        assertTrue(UpdateVersions.shouldCheck(start, start - 5, force = false))
        assertEquals(12L * 60L * 60L * 1000L, UpdateVersions.CHECK_INTERVAL_MS)
    }

    @Test fun playPriorityFourOrFiveIsImmediate() {
        assertEquals(
            UpdateVersions.PlayFlow.FLEXIBLE,
            UpdateVersions.choosePlayFlow(true, priority = 0, immediateAllowed = true, flexibleAllowed = true),
        )
        assertEquals(
            UpdateVersions.PlayFlow.FLEXIBLE,
            UpdateVersions.choosePlayFlow(true, priority = 3, immediateAllowed = true, flexibleAllowed = true),
        )
        assertEquals(
            UpdateVersions.PlayFlow.IMMEDIATE,
            UpdateVersions.choosePlayFlow(true, priority = 4, immediateAllowed = true, flexibleAllowed = true),
        )
        assertEquals(
            UpdateVersions.PlayFlow.IMMEDIATE,
            UpdateVersions.choosePlayFlow(true, priority = 5, immediateAllowed = true, flexibleAllowed = true),
        )
        assertEquals(
            UpdateVersions.PlayFlow.FLEXIBLE,
            UpdateVersions.choosePlayFlow(true, priority = 5, immediateAllowed = false, flexibleAllowed = true),
        )
        assertEquals(
            UpdateVersions.PlayFlow.IMMEDIATE,
            UpdateVersions.choosePlayFlow(true, priority = 0, immediateAllowed = true, flexibleAllowed = false),
        )
        assertEquals(
            UpdateVersions.PlayFlow.NONE,
            UpdateVersions.choosePlayFlow(true, priority = 5, immediateAllowed = false, flexibleAllowed = false),
        )
        assertEquals(
            UpdateVersions.PlayFlow.NONE,
            UpdateVersions.choosePlayFlow(false, priority = 5, immediateAllowed = true, flexibleAllowed = true),
        )
    }

    @Test fun manifestVersionCodeBeatsTheApkName() {
        val release = releaseWithApk("drivebay-3.34.5.apk")
        val manifest = UpdateVersions.parseManifest(
            """{"minimum":"3.36","latest":"3.36.3","androidVersionCode":33410,"androidVersionName":"3.34.10","androidMinVersionCode":33400}""",
        )!!
        val offer = UpdateVersions.resolveOffer(33405, release, manifest)!!
        assertEquals(33410L, offer.versionCode)
        assertEquals("3.34.10", offer.versionName)
        assertEquals("drivebay-3.34.5.apk", offer.assetName)
        assertFalse(offer.required)
        assertNull(UpdateVersions.resolveOffer(33410, release, manifest))
    }

    @Test fun desktopManifestFallsBackToTheApkName() {
        val release = releaseWithApk("drivebay-3.34.5.apk")
        val manifest = UpdateVersions.parseManifest(
            """{"minimum":"3.36","latest":"3.36.3","message":"Install the latest release."}""",
        )!!
        assertNull(manifest.androidVersionCode)
        val offer = UpdateVersions.resolveOffer(33404, release, manifest)!!
        assertEquals(33405L, offer.versionCode)
        assertEquals("https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/download/v/drivebay-3.34.5.apk", offer.downloadUrl)
    }

    @Test fun versionJsonShapeSuppliesTheCode() {
        val manifest = UpdateVersions.parseManifest(
            """{"minVersionCode":33400,"latestVersionCode":33405,"message":"Update"}""",
        )!!
        assertEquals(33405L, manifest.androidVersionCode)
        assertEquals(33400L, manifest.androidMinVersionCode)
        val release = UpdateVersions.parseRelease(
            """{"tag_name":"v","assets":[{"name":"app-release.apk","browser_download_url":"https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/download/v/app-release.apk"}]}""",
        )
        val offer = UpdateVersions.resolveOffer(33404, release, manifest)!!
        assertEquals(33405L, offer.versionCode)
        assertTrue(offer.required.not())
        val forced = UpdateVersions.resolveOffer(33300, release, manifest)!!
        assertTrue(forced.required)
    }

    @Test fun noApkOrOlderApkIsNotAnOffer() {
        val listing = UpdateVersions.parseRelease(
            """{"tag_name":"v3.36.3","assets":[
              {"name":"version-manifest.json","browser_download_url":"https://github.com/acme/drivebay/releases/download/v/version-manifest.json"},
              {"name":"Drivebay-Setup-3.36.3.exe","browser_download_url":"https://github.com/acme/drivebay/releases/download/v/Drivebay-Setup.exe"}
            ]}""",
        )!!
        assertEquals("version-manifest.json", UpdateVersions.manifestAsset(listing)!!.name)
        assertNull(UpdateVersions.resolveOffer(33404, listing, UpdateVersions.parseManifest("""{"latest":"3.36.3","minimum":"3.36"}""")))
        val same = releaseWithApk("drivebay-33404.apk")
        assertNull(UpdateVersions.resolveOffer(33404, same, null))
    }

    @Test fun picksTheNewerDrivebayApkAndSkipsDebug() {
        val release = UpdateVersions.parseRelease(
            """{"assets":[
              {"name":"drivebay-debug.apk","browser_download_url":"https://github.com/acme/drivebay/releases/download/v/drivebay-debug.apk"},
              {"name":"drivebay-3.34.4.apk","browser_download_url":"https://github.com/acme/drivebay/releases/download/v/a.apk"},
              {"name":"drivebay-3.34.5.apk","browser_download_url":"https://github.com/acme/drivebay/releases/download/v/b.apk"}
            ]}""",
        )
        val offer = UpdateVersions.resolveOffer(1, release, null)!!
        assertEquals("drivebay-3.34.5.apk", offer.assetName)
        assertEquals(33405L, offer.versionCode)
    }

    @Test fun namedApkInTheManifestWins() {
        val release = releaseWithApk("drivebay-3.34.5.apk")
        val withOther = UpdateVersions.parseRelease(
            """{"assets":[
              {"name":"drivebay-3.34.9.apk","browser_download_url":"https://github.com/acme/drivebay/releases/download/v/new.apk"},
              {"name":"drivebay-3.34.5.apk","browser_download_url":"https://github.com/acme/drivebay/releases/download/v/old.apk"}
            ]}""",
        )
        val manifest = UpdateVersions.parseManifest("""{"androidApk":"drivebay-3.34.5.apk","androidVersionCode":33408}""")
        val offer = UpdateVersions.resolveOffer(33400, withOther, manifest)!!
        assertEquals("drivebay-3.34.5.apk", offer.assetName)
        assertEquals(33408L, offer.versionCode)
        assertEquals(33405L, UpdateVersions.resolveOffer(1, release, null)!!.versionCode)
    }

    @Test fun rejectsNonGithubAndCleartextDownloads() {
        assertTrue(UpdateVersions.isAllowedDownloadUrl("https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/download/v/a.apk"))
        assertTrue(UpdateVersions.isAllowedDownloadUrl("https://api.github.com/repos/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/latest"))
        assertTrue(UpdateVersions.isAllowedDownloadUrl("https://objects.githubusercontent.com/a/b"))
        assertTrue(UpdateVersions.isAllowedDownloadUrl("https://release-assets.githubusercontent.com/a"))
        assertFalse(UpdateVersions.isAllowedDownloadUrl("http://github.com/acme/a.apk"))
        assertFalse(UpdateVersions.isAllowedDownloadUrl("https://evil.example/a.apk"))
        assertFalse(UpdateVersions.isAllowedDownloadUrl("https://github.com.evil.test/a.apk"))
        assertFalse(UpdateVersions.isAllowedDownloadUrl("https://user:pass@github.com/a.apk"))
        val sneaky = UpdateVersions.parseRelease(
            """{"assets":[{"name":"drivebay-3.34.5.apk","browser_download_url":"https://evil.example/drivebay.apk"}]}""",
        )
        assertNull(UpdateVersions.resolveOffer(1, sneaky, null))
    }

    @Test fun badReleaseAndManifestFailOpen() {
        assertNull(UpdateVersions.parseRelease(null))
        assertNull(UpdateVersions.parseRelease(""))
        assertNull(UpdateVersions.parseRelease("<html>"))
        assertNull(UpdateVersions.parseRelease("{" + " ".repeat(UpdateVersions.MAX_RELEASE_BYTES) + "}"))
        assertNull(UpdateVersions.parseManifest(null))
        assertNull(UpdateVersions.parseManifest(""))
        assertNull(UpdateVersions.parseManifest("[]"))
        assertNull(UpdateVersions.resolveOffer(33404, null, null))
    }

    private fun releaseWithApk(name: String) = UpdateVersions.parseRelease(
        """{"tag_name":"v","assets":[
          {"name":"version-manifest.json","browser_download_url":"https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/download/v/version-manifest.json"},
          {"name":"$name","browser_download_url":"https://github.com/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/download/v/$name"}
        ]}""",
    )
}
