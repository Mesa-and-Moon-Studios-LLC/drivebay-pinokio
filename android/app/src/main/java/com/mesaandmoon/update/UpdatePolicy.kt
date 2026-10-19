package com.mesaandmoon.update

import org.json.JSONObject

/**
 * Mesa and Moon shared update check: the pure decision logic (no Android calls, unit tested).
 *
 * Server file format (version.json / app-version.json):
 *   { "minVersionCode": 33304, "latestVersionCode": 33304, "message": "..." }
 *
 * - installed < minVersionCode  -> REQUIRED (Play IMMEDIATE flow, app is blocked until updated)
 * - installed < latestVersionCode -> OPTIONAL (dismissible banner, Play FLEXIBLE flow)
 * - anything else, an unreadable file, or Play reporting no update -> NONE (app opens normally)
 */
data class VersionConfig(
    val minVersionCode: Long,
    val latestVersionCode: Long,
    val message: String?,
)

enum class UpdateAction { NONE, OPTIONAL, REQUIRED }

object UpdatePolicy {
    /** Largest version file we will read; anything bigger is treated as unreadable. */
    const val MAX_BYTES = 64 * 1024

    /** Returns null when the text is not a usable version file (fail open). */
    fun parse(json: String?): VersionConfig? {
        if (json.isNullOrBlank() || json.length > MAX_BYTES) return null
        return try {
            val o = JSONObject(json)
            if (!o.has("minVersionCode") && !o.has("latestVersionCode")) return null
            val min = o.optLong("minVersionCode", 0L).coerceAtLeast(0L)
            val latest = o.optLong("latestVersionCode", 0L).coerceAtLeast(0L)
            // "message" is the shared field; Cipher Vault's older file used forceBody.
            val message = sequenceOf("message", "forceBody")
                .map { o.optString(it, "").trim() }
                .firstOrNull { it.isNotEmpty() }
            VersionConfig(min, maxOf(min, latest), message)
        } catch (_: Exception) {
            null
        }
    }

    fun decide(
        installedVersionCode: Long,
        config: VersionConfig?,
        playHasUpdate: Boolean,
        immediateAllowed: Boolean,
        flexibleAllowed: Boolean,
    ): UpdateAction {
        if (config == null || !playHasUpdate) return UpdateAction.NONE
        if (installedVersionCode < config.minVersionCode && immediateAllowed) return UpdateAction.REQUIRED
        if (installedVersionCode < config.latestVersionCode && flexibleAllowed) return UpdateAction.OPTIONAL
        return UpdateAction.NONE
    }

    /** Only copies installed by the Play Store can use Play's in-app update flows. */
    fun isPlayInstaller(installerPackage: String?): Boolean = installerPackage == PLAY_STORE

    const val PLAY_STORE = "com.android.vending"
}
