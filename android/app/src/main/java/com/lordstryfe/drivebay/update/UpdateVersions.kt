package com.lordstryfe.drivebay.update

import org.json.JSONObject
import java.net.URI

/**
 * Pure update rules: how often to check, Play flexible vs immediate, and
 * whether a GitHub release APK is newer than the installed versionCode.
 *
 * Desktop releases ship version-manifest.json with "minimum" and "latest"
 * semver strings. Android reads that file when the release has one, and uses
 * androidVersionCode (or the APK file name) for the comparison. A desktop
 * version string is never treated as an Android versionCode.
 */
object UpdateVersions {
    /** At most one automatic check per 12 hours. Settings can force another. */
    const val CHECK_INTERVAL_MS = 12L * 60L * 60L * 1000L

    /**
     * Play Console update priority is 0–5. 4 and 5 are the high values Play's
     * own sample uses for the immediate flow. 0–3 stay on the flexible flow.
     */
    const val IMMEDIATE_PRIORITY = 4

    const val MANIFEST_NAME = "version-manifest.json"
    const val RELEASES_LATEST =
        "https://api.github.com/repos/Mesa-and-Moon-Studios-LLC/drivebay-pinokio/releases/latest"
    const val MAX_MANIFEST_BYTES = 64 * 1024
    const val MAX_RELEASE_BYTES = 1024 * 1024
    const val MAX_APK_BYTES = 150L * 1024L * 1024L

    const val PROMPT_TITLE = "Update available"
    const val PROMPT_ACTION = "Update"
    const val RESTART_ACTION = "Restart"
    const val RESTART_MESSAGE = "Update downloaded. Restart to finish."

    enum class PlayFlow { NONE, FLEXIBLE, IMMEDIATE }

    fun shouldCheck(lastCheckAtMs: Long, nowMs: Long, force: Boolean): Boolean {
        if (force) return true
        if (lastCheckAtMs <= 0L) return true
        if (nowMs < lastCheckAtMs) return true
        return nowMs - lastCheckAtMs >= CHECK_INTERVAL_MS
    }

    /** True when the release's versionCode is strictly newer. */
    fun isNewerVersion(installedVersionCode: Long, availableVersionCode: Long): Boolean =
        availableVersionCode > installedVersionCode && availableVersionCode > 0L

    /**
     * Flexible when Play has an update. Immediate when a high priority is set
     * and Play allows that flow. If flexible is not allowed, immediate is the fallback.
     */
    fun choosePlayFlow(
        updateAvailable: Boolean,
        priority: Int,
        immediateAllowed: Boolean,
        flexibleAllowed: Boolean,
    ): PlayFlow {
        if (!updateAvailable) return PlayFlow.NONE
        if (priority >= IMMEDIATE_PRIORITY && immediateAllowed) return PlayFlow.IMMEDIATE
        if (flexibleAllowed) return PlayFlow.FLEXIBLE
        if (immediateAllowed) return PlayFlow.IMMEDIATE
        return PlayFlow.NONE
    }

    data class Asset(val name: String, val downloadUrl: String)

    data class ReleaseListing(val assets: List<Asset>)

    /** Null when the body is not a GitHub release object. An empty asset list is still a release. */
    fun parseRelease(json: String?): ReleaseListing? {
        if (json.isNullOrBlank() || json.length > MAX_RELEASE_BYTES) return null
        return try {
            val root = JSONObject(json)
            if (!root.has("assets") && !root.has("tag_name") && !root.has("name")) return null
            val arr = root.optJSONArray("assets")
            val assets = ArrayList<Asset>()
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val item = arr.optJSONObject(i) ?: continue
                    val name = item.optString("name", "").trim()
                    val url = item.optString("browser_download_url", "").trim()
                    if (name.isEmpty() || url.isEmpty()) continue
                    assets.add(Asset(name, url))
                }
            }
            ReleaseListing(assets)
        } catch (_: Exception) {
            null
        }
    }

    data class Manifest(
        val androidVersionCode: Long?,
        val androidMinVersionCode: Long?,
        val androidVersionName: String?,
        val androidApk: String?,
        val message: String?,
    )

    /**
     * Accepts version-manifest.json. Android codes are optional, so a desktop-only
     * file still parses and the APK file name supplies the versionCode.
     */
    fun parseManifest(json: String?): Manifest? {
        if (json.isNullOrBlank() || json.length > MAX_MANIFEST_BYTES) return null
        return try {
            val o = JSONObject(json)
            if (o.length() == 0) return null
            val code = longField(o, "androidVersionCode")
                ?: longField(o, "versionCode")
                ?: if (o.has("minVersionCode") || o.has("androidVersionName")) longField(o, "latestVersionCode") else null
            val min = longField(o, "androidMinVersionCode") ?: longField(o, "minVersionCode")
            val name = stringField(o, "androidVersionName") ?: stringField(o, "versionName")
            val apk = stringField(o, "androidApk") ?: stringField(o, "apk")
            val message = stringField(o, "message")
            val desktop = o.has("minimum") || o.has("latest")
            if (code == null && min == null && name == null && apk == null && message == null && !desktop) return null
            Manifest(code?.takeIf { it > 0L }, min?.takeIf { it > 0L }, name, apk, message)
        } catch (_: Exception) {
            null
        }
    }

    fun manifestAsset(release: ReleaseListing): Asset? =
        release.assets.firstOrNull { asset ->
            val base = asset.name.substringAfterLast('/').substringAfterLast('\\')
            base.equals(MANIFEST_NAME, ignoreCase = true)
        }

    fun versionCodeFromApkName(name: String): Long? {
        val base = name.substringAfterLast('/').substringAfterLast('\\')
        val tagged = Regex("""versionCode[_-]?(\d+)""", RegexOption.IGNORE_CASE).find(base)
        if (tagged != null) {
            return tagged.groupValues[1].toLongOrNull()?.takeIf { it > 0L }
        }
        val packedDigits = Regex("""(?<!\d)(\d{5,7})(?!\d)""")
            .findAll(base)
            .mapNotNull { it.groupValues[1].toLongOrNull() }
            .filter { it in 10_000L..9_999_999L }
            .toList()
        if (packedDigits.isNotEmpty()) return packedDigits.maxOrNull()
        return packVersionName(base)
    }

    /**
     * Drivebay's Android versionCode since 3.33.4: major * 10000 + minor * 100 + patch.
     * 3.34.5 is 33405. A two-part number is not packed, so a desktop "3.36" is ignored.
     */
    fun packVersionName(text: String): Long? {
        val match = Regex("""(?<!\d)(\d+)\.(\d+)\.(\d+)(?!\d)""").find(text) ?: return null
        val major = match.groupValues[1].toLongOrNull() ?: return null
        val minor = match.groupValues[2].toLongOrNull() ?: return null
        val patch = match.groupValues[3].toLongOrNull() ?: return null
        if (major !in 0..99 || minor !in 0..99 || patch !in 0..99) return null
        return major * 10_000L + minor * 100L + patch
    }

    fun chooseApk(assets: List<Asset>, manifest: Manifest?): Asset? {
        val apks = assets.filter { it.name.endsWith(".apk", ignoreCase = true) }
        if (apks.isEmpty()) return null
        val named = manifest?.androidApk?.trim().orEmpty()
        if (named.isNotEmpty()) {
            apks.firstOrNull { it.name.equals(named, ignoreCase = true) }?.let { return it }
        }
        fun preferred(list: List<Asset>) = list.filter { asset ->
            val n = asset.name.lowercase()
            "drivebay" in n && "debug" !in n
        }
        val pool = preferred(apks).ifEmpty {
            apks.filter { "debug" !in it.name.lowercase() }.ifEmpty { apks }
        }
        return pool.maxWithOrNull(compareBy<Asset> { versionCodeFromApkName(it.name) ?: Long.MIN_VALUE })
    }

    data class ApkOffer(
        val versionCode: Long,
        val versionName: String?,
        val downloadUrl: String,
        val assetName: String,
        val required: Boolean,
    )

    /**
     * An offer only when the release has an APK whose versionCode is higher
     * than [installedVersionCode]. The manifest code wins over the file name.
     * Null means there is nothing to install (not a failed download).
     */
    fun resolveOffer(installedVersionCode: Long, release: ReleaseListing?, manifest: Manifest?): ApkOffer? {
        if (release == null) return null
        val apk = chooseApk(release.assets, manifest) ?: return null
        if (!isAllowedDownloadUrl(apk.downloadUrl)) return null
        val code = manifest?.androidVersionCode
            ?: versionCodeFromApkName(apk.name)
            ?: manifest?.androidVersionName?.let { packVersionName(it) }
            ?: return null
        if (!isNewerVersion(installedVersionCode, code)) return null
        val required = manifest?.androidMinVersionCode?.let { installedVersionCode < it } == true
        return ApkOffer(
            versionCode = code,
            versionName = manifest?.androidVersionName,
            downloadUrl = apk.downloadUrl,
            assetName = apk.name,
            required = required,
        )
    }

    /** GitHub release and asset hosts only, https, no embedded user info. */
    fun isAllowedDownloadUrl(url: String): Boolean {
        val uri = try {
            URI(url)
        } catch (_: Exception) {
            return false
        }
        if (!uri.scheme.equals("https", ignoreCase = true)) return false
        if (!uri.userInfo.isNullOrEmpty()) return false
        val host = uri.host?.lowercase() ?: return false
        return host == "github.com" ||
            host == "api.github.com" ||
            host == "objects.githubusercontent.com" ||
            host == "release-assets.githubusercontent.com" ||
            host.endsWith(".githubusercontent.com")
    }

    private fun longField(o: JSONObject, key: String): Long? {
        if (!o.has(key) || o.isNull(key)) return null
        val n = when (val raw = o.opt(key)) {
            is Number -> raw.toLong()
            is String -> raw.trim().toLongOrNull()
            else -> null
        } ?: return null
        return n.coerceAtLeast(0L)
    }

    private fun stringField(o: JSONObject, key: String): String? {
        if (!o.has(key) || o.isNull(key)) return null
        return o.optString(key, "").trim().ifEmpty { null }
    }
}
