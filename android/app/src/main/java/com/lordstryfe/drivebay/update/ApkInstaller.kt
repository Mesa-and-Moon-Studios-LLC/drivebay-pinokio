package com.lordstryfe.drivebay.update

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.lordstryfe.drivebay.DownloadOpen
import java.io.File

/** Opens the system package installer for an APK shared through FileProvider. */
object ApkInstaller {
    const val MIME = "application/vnd.android.package-archive"

    fun canInstall(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
        return context.packageManager.canRequestPackageInstalls()
    }

    fun unknownSourcesIntent(context: Context): Intent =
        Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${context.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    fun installIntent(context: Context, apk: File): Intent {
        val uri = FileProvider.getUriForFile(context, DownloadOpen.authority(context.packageName), apk)
        return Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, MIME)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            clipData = ClipData.newRawUri("", uri)
        }
    }
}
