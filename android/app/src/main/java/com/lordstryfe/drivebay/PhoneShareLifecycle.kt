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
    /** Peer id of the credential that just authenticated, when several PCs are paired. */
    const val CLIENT_HEADER = "X-Drivebay-Client"
    /** Hostname the PC sends so a new pairing can be named before the user renames it. */
    const val PC_NAME_HEADER = "X-Drivebay-PC-Name"
    const val HEALTHY_POLL_MS = 15_000L

    /** First 16 hex chars of the token hash. Stable for one token, not reversible to it. */
    fun peerId(tokenHash: String?): String? {
        if (tokenHash == null || !tokenHash.matches(Regex("^[0-9a-f]{64}$"))) return null
        return tokenHash.substring(0, 16)
    }

    fun shouldResume(enabled: Boolean, tokenHash: String?, folderCount: Int, wholePhone: Boolean = false): Boolean {
        return enabled && peerId(tokenHash) != null && (wholePhone || folderCount > 0)
    }

    /** Sharing stays up when any paired PC still has a token. Boot resume uses this and does not ask for the owner password. */
    fun shouldResume(enabled: Boolean, pairs: List<PhonePair>, folderCount: Int, wholePhone: Boolean = false): Boolean {
        return enabled && pairs.any { peerId(it.tokenHash) != null } && (wholePhone || folderCount > 0)
    }

    /** OPTIONS advertises every paired PC. The PC matches its own id inside the list. */
    fun peerHeader(ids: Collection<String>): String =
        ids.map { it.trim().lowercase() }.filter { it.matches(Regex("^[0-9a-f]{8,32}$")) }.distinct().joinToString(",")

    /** One discovery datagram per PC. The PC parser accepts exactly three fields, so these are not combined. */
    fun discoveryMessages(peerIds: Collection<String>, httpPort: Int): List<String> =
        peerIds.map { it.trim().lowercase() }.filter { it.matches(Regex("^[0-9a-f]{8,32}$")) }.distinct()
            .map { discoveryMessage(it, httpPort) }

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
