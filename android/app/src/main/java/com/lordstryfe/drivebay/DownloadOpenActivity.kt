package com.lordstryfe.drivebay

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.os.Bundle
import android.widget.Toast

/** Hands a finished download to another app as Open or Share. */
class DownloadOpenActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uri = intent?.data
        val mime = intent?.type ?: "application/octet-stream"
        if (uri == null) {
            finish()
            return
        }
        val share = intent.getBooleanExtra(EXTRA_SHARE, false)
        val target = if (share) {
            Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                clipData = ClipData.newRawUri("Drivebay", uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }.let { Intent.createChooser(it, "Share") }
        } else {
            Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mime)
                clipData = ClipData.newRawUri("Drivebay", uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        }
        target.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            val resolved = packageManager.queryIntentActivities(target, 0)
            for (info in resolved) {
                grantUriPermission(info.activityInfo.packageName, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(target)
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, "No app can open this file", Toast.LENGTH_LONG).show()
        }
        finish()
    }

    companion object {
        const val EXTRA_SHARE = "share"
    }
}
