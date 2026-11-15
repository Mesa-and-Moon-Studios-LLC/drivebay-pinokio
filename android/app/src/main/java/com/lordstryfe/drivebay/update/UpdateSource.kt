package com.lordstryfe.drivebay.update

/**
 * Where this copy of Drivebay was installed from.
 *
 * Play copies update through Google Play. Every other installer (sideload,
 * adb, a file manager, another store) is [SIDELOAD] and checks GitHub.
 */
enum class UpdateSource {
    PLAY,
    SIDELOAD;

    companion object {
        /** Package name of the Google Play Store. */
        const val PLAY_INSTALLER = "com.android.vending"

        fun detect(installerPackage: String?): UpdateSource =
            if (installerPackage == PLAY_INSTALLER) PLAY else SIDELOAD
    }
}
