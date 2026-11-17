package com.lordstryfe.drivebay.license

/**
 * What each edition unlocks. Mirrors app/src/lib/license/edition-policy.mjs.
 * Free keeps everything needed to link and use your own machines. A lapsed or missing license only
 * turns the paid extras back off.
 */
object EditionPolicy {
    val ORDER = listOf("free", "pro", "elite", "enterprise")
    val NAMES = mapOf("free" to "Free", "pro" to "Pro", "elite" to "Elite", "enterprise" to "Enterprise")

    private data class Row(val remote: Boolean, val publicAccess: Boolean, val minutes: List<Int>, val sharedFolders: Int)

    private val POLICY = mapOf(
        "free" to Row(false, false, emptyList(), 3),
        "pro" to Row(true, true, listOf(15, 60, 240), 25),
        "elite" to Row(true, true, listOf(15, 60, 240, 1440), -1),
        "enterprise" to Row(true, true, listOf(15, 60, 240, 1440), -1),
    )

    private fun row(edition: String) = POLICY[edition] ?: POLICY.getValue("free")

    fun allows(edition: String, feature: String): Boolean = when (feature) {
        "remote_access" -> row(edition).remote
        "public_access" -> row(edition).publicAccess
        "remote_24h" -> 1440 in row(edition).minutes
        else -> false
    }

    fun remoteMinutesAllowed(edition: String, minutes: Int) = minutes in row(edition).minutes

    fun sharedFolderLimit(edition: String) = row(edition).sharedFolders

    fun requiredEdition(feature: String) = if (feature == "remote_24h") "elite" else "pro"

    fun upgradeMessage(feature: String, current: String = "free"): String {
        val need = NAMES.getValue(requiredEdition(feature))
        return when (feature) {
            "remote_access" ->
                "Remote access is a $need feature. Your own machines still link and open each other for free. Upgrade to turn on time-limited remote access from a trusted device."
            "public_access" ->
                "Public access is a $need feature. Tailscale and your own machines keep working. Upgrade to open a port you forwarded yourself."
            "remote_24h" -> "24-hour remote sessions are an Elite feature. Pick 15 minutes, 1 hour or 4 hours, or upgrade to Elite."
            "shared_folders" ->
                "You are at the shared folder limit for ${NAMES[current] ?: "Free"}. Your existing folders keep working. Upgrade to share more."
            else -> "This is a $need feature."
        }
    }
}
