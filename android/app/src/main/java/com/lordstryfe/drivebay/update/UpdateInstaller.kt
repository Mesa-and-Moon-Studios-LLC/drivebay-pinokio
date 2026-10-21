package com.lordstryfe.drivebay.update

import android.content.Context
import android.os.Build

/** Reads the package installer and maps it to [UpdateSource]. */
object UpdateInstaller {
    fun installerPackage(context: Context): String? = runCatching {
        val pm = context.packageManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            pm.getInstallSourceInfo(context.packageName).installingPackageName
        } else {
            @Suppress("DEPRECATION")
            pm.getInstallerPackageName(context.packageName)
        }
    }.getOrNull()

    fun source(context: Context): UpdateSource = UpdateSource.detect(installerPackage(context))
}
