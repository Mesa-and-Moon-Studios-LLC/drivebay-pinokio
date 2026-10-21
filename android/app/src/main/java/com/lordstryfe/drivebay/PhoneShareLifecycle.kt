package com.lordstryfe.drivebay

/**
 * Pure rules for the phone-as-drive share: when to bring the server back,
 * how long to wait between tries, and how the green banner shares the screen
 * with the file list. No Android APIs, so unit tests can run these.
 */
object PhoneShareLifecycle {
    const val DISCOVERY_PORT = 8781
    const val DISCOVERY_QUERY = "DRIVEBAY?"
    const val DISCOVERY_MAGIC = "DRIVEBAY1"
    const val PEER_HEADER = "X-Drivebay-Phone"
    const val HEALTHY_POLL_MS = 15_000L

    /** EADDRINUSE on Linux and Android. A live listen socket still holds the port. */
    const val EADDRINUSE = 98

    /** Bind failures to absorb before phone sharing is turned off with a port-in-use message. */
    const val PORT_IN_USE_TRIES = 5

    /** Manifest foregroundServiceType for [com.lordstryfe.drivebay.PhoneShareService]. */
    const val FOREGROUND_SERVICE_TYPES = "specialUse|dataSync"

    /** Where a resume of the phone-share foreground service was requested. */
    enum class ShareStartOrigin {
        /** Process start. Never allowed: mAllowStartForeground is still false. */
        APPLICATION,
        /** Activity is in the foreground (onResume). */
        ACTIVITY,
        /** ACTION_BOOT_COMPLETED, allowed only for foreground types Android exempts. */
        BOOT_COMPLETED,
        /** ACTION_MY_PACKAGE_REPLACED. Android treats this as a background-start exemption. */
        PACKAGE_REPLACED,
    }

    /** First 16 hex chars of the token hash. Stable for one token, not reversible to it. */
    fun peerId(tokenHash: String?): String? {
        if (tokenHash == null || !tokenHash.matches(Regex("^[0-9a-f]{64}$"))) return null
        return tokenHash.substring(0, 16)
    }

    fun shouldResume(enabled: Boolean, tokenHash: String?, folderCount: Int, wholePhone: Boolean = false): Boolean {
        return enabled && peerId(tokenHash) != null && (wholePhone || folderCount > 0)
    }

    /**
     * True when this origin may call startForegroundService.
     * Application.onCreate is never allowed. An activity in the foreground is.
     * BOOT_COMPLETED is allowed except for the types Android 15 blocks when targetSdk is 35+
     * (dataSync, camera, mediaPlayback, phoneCall, mediaProjection), and microphone since target 34.
     * specialUse alone is allowed from boot. This service also declares dataSync, so boot is not.
     */
    fun allowsForegroundStart(origin: ShareStartOrigin, foregroundServiceTypes: String, targetSdk: Int): Boolean {
        return when (origin) {
            ShareStartOrigin.APPLICATION -> false
            ShareStartOrigin.ACTIVITY -> true
            ShareStartOrigin.PACKAGE_REPLACED -> true
            ShareStartOrigin.BOOT_COMPLETED -> bootCompletedExempt(foregroundServiceTypes, targetSdk)
        }
    }

    fun bootCompletedExempt(foregroundServiceTypes: String, targetSdk: Int): Boolean {
        val types = foregroundServiceTypes.split('|').map { it.trim() }.filter { it.isNotEmpty() }
        val blockedAt35 = setOf("dataSync", "camera", "mediaPlayback", "phoneCall", "mediaProjection")
        if (targetSdk >= 35 && types.any { it in blockedAt35 }) return false
        if (targetSdk >= 34 && types.any { it == "microphone" }) return false
        return true
    }

    /**
     * True for ForegroundServiceStartNotAllowedException, including when it is wrapped.
     * The class is not on the JVM test classpath, so the name and the system message are checked.
     */
    fun isForegroundStartBlocked(error: Throwable?): Boolean {
        var current = error
        val seen = HashSet<Throwable>()
        while (current != null && seen.add(current)) {
            val name = current.javaClass.name
            val simple = name.substringAfterLast('.').substringAfterLast('$')
            if (simple == "ForegroundServiceStartNotAllowedException") return true
            val message = current.message?.lowercase().orEmpty()
            if (message.contains("mallowstartforeground")) return true
            if (message.contains("startforegroundservice") && message.contains("not allowed")) return true
            current = current.cause
        }
        return false
    }

    /**
     * True when [error] is EADDRINUSE. Walks the cause chain, including Android's
     * ErrnoException (errno 98), whose class is not on the JVM test classpath.
     */
    fun isAddressInUse(error: Throwable?): Boolean {
        var current = error
        val seen = HashSet<Throwable>()
        while (current != null && seen.add(current)) {
            val message = current.message?.lowercase().orEmpty()
            if (message.contains("eaddrinuse") || message.contains("address already in use")) return true
            if (errnoOf(current) == EADDRINUSE) return true
            current = current.cause
        }
        return false
    }

    /** True after [PORT_IN_USE_TRIES] failed binds, counting from 1. */
    fun portInUseExhausted(failures: Int): Boolean = failures >= PORT_IN_USE_TRIES

    private fun errnoOf(error: Throwable): Int? {
        val method = error.javaClass.methods.firstOrNull { it.name == "getErrno" && it.parameterCount == 0 } ?: return null
        return runCatching { method.invoke(error) as? Int }.getOrNull()
    }

    /** 1s, 2s, 4s, 8s, 16s, then 30s. */
    fun retryDelayMs(attempt: Int): Long {
        val steps = attempt.coerceIn(0, 5)
        var delay = 1_000L
        repeat(steps) { delay *= 2 }
        return minOf(delay, 30_000L)
    }

    fun sameHosts(current: Collection<String>, bound: Collection<String>): Boolean {
        fun norm(list: Collection<String>) = list.map { it.trim().lowercase() }.filter { it.isNotEmpty() }.toSet()
        return norm(current) == norm(bound)
    }

    fun discoveryMessage(peer: String, httpPort: Int): String = "$DISCOVERY_MAGIC $peer $httpPort"

    fun parseDiscovery(message: String?): DiscoveryReply? {
        if (message.isNullOrBlank()) return null
        val parts = message.trim().split(Regex("\\s+"))
        if (parts.size != 3 || parts[0] != DISCOVERY_MAGIC) return null
        if (!parts[1].matches(Regex("^[0-9a-f]{8,32}$"))) return null
        val port = parts[2].toIntOrNull() ?: return null
        if (port !in 1..65535) return null
        return DiscoveryReply(parts[1], port)
    }

    fun bannerText(
        title: String,
        connectedLabel: String,
        reconnectingLabel: String,
        hosts: List<String>,
        port: Int,
    ): String {
        if (hosts.isEmpty()) return "$title\n$reconnectingLabel"
        val urls = hosts.joinToString("  ") { "http://$it:$port/" }
        return "$title\n$connectedLabel\n$urls"
    }
}

data class DiscoveryReply(val peerId: String, val port: Int)

/**
 * The banner occupies its own band under the status bar. The file list starts
 * below that band, so the first row is not covered and can scroll.
 */
object ShareScreenLayout {
    fun listTop(statusBarInsetPx: Int, bannerHeightPx: Int, bannerVisible: Boolean): Int {
        val inset = statusBarInsetPx.coerceAtLeast(0)
        val banner = if (bannerVisible) bannerHeightPx.coerceAtLeast(0) else 0
        return inset + banner
    }

    fun firstRowVisible(
        statusBarInsetPx: Int,
        bannerHeightPx: Int,
        bannerVisible: Boolean,
        rowTopPx: Int,
    ): Boolean = rowTopPx >= listTop(statusBarInsetPx, bannerHeightPx, bannerVisible)
}
