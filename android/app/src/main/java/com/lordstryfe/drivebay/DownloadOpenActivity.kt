package com.lordstryfe.drivebay

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.MimeTypeMap
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File

/**
 * Hands a finished download to another app as Open or Share.
 * The file is a FileProvider content URI so the other app can read it.
 */
class DownloadOpenActivity : Activity() {
    private var handedOff = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val source = sourceUri()
        val name = intent?.getStringExtra(EXTRA_NAME).orEmpty()
        val mime = resolvedMime(name, intent?.type)
        if (source == null) {
            toast(R.string.download_open_failed)
            finish()
            return
        }
        val share = intent.getBooleanExtra(EXTRA_SHARE, false)
        if (DownloadOpen.isFileProviderUri(source.toString(), packageName)) {
            handOff(source, mime, share)
            return
        }
        Thread({
            val shared = try {
                copyToFileProvider(source, name)
            } catch (_: Exception) {
                null
            }
            runOnUiThread {
                if (isFinishing) return@runOnUiThread
                if (shared == null) {
                    toast(R.string.download_open_failed)
                    finish()
                } else {
                    handOff(shared, mime, share)
                }
            }
        }, "drivebay-open").start()
    }

    override fun onStop() {
        super.onStop()
        if (handedOff && !isFinishing) finish()
    }

    private fun handOff(uri: Uri, mime: String, share: Boolean) {
        val view = if (share) {
            Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                clipData = ClipData.newRawUri("Drivebay", uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        } else {
            Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mime)
                clipData = ClipData.newRawUri("Drivebay", uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        }
        val matches = queryHandlers(view)
        if (DownloadOpen.step(matches.size) == DownloadOpen.Step.TOAST) {
            toast(if (share) R.string.download_no_share else R.string.download_no_app)
            finish()
            return
        }
        for (info in matches) {
            grantUriPermission(info.activityInfo.packageName, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val title = getString(if (share) R.string.download_share else R.string.download_open)
        val chooser = Intent.createChooser(view, title).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            clipData = ClipData.newRawUri("Drivebay", uri)
        }
        try {
            handedOff = true
            startActivity(chooser)
        } catch (_: ActivityNotFoundException) {
            handedOff = false
            toast(if (share) R.string.download_no_share else R.string.download_no_app)
            finish()
        }
    }

    private fun copyToFileProvider(source: Uri, name: String): Uri {
        val dir = File(cacheDir, "open")
        if (!dir.isDirectory && !dir.mkdirs()) error("open cache")
        val dest = File(dir, DownloadOpen.cacheFileName(name, source.toString()))
        if (!dest.exists() || dest.length() == 0L) {
            contentResolver.openInputStream(source)?.use { input ->
                dest.outputStream().use { input.copyTo(it) }
            } ?: error("unreadable")
        }
        if (!dest.isFile || dest.length() == 0L) error("empty")
        return FileProvider.getUriForFile(this, DownloadOpen.authority(packageName), dest)
    }

    private fun sourceUri(): Uri? {
        val extra = intent?.getStringExtra(EXTRA_URI)?.takeIf { it.isNotBlank() }?.let(Uri::parse)
        return extra ?: intent?.data
    }

    private fun resolvedMime(name: String, provided: String?): String {
        val typed = DownloadOpen.mimeType(name, provided)
        if (typed != DownloadOpen.OCTET) return typed
        val ext = name.substringAfterLast('.', "")
        if (ext.isBlank() || ext == name) return typed
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.lowercase()) ?: typed
    }

    private fun queryHandlers(target: Intent) =
        if (Build.VERSION.SDK_INT >= 33) {
            packageManager.queryIntentActivities(target, PackageManager.ResolveInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            packageManager.queryIntentActivities(target, 0)
        }

    private fun toast(message: Int) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }

    companion object {
        const val EXTRA_SHARE = "share"
        const val EXTRA_URI = "uri"
        const val EXTRA_NAME = "name"

        /** Puts the URI and MIME on together. Setting type after data would clear the URI. */
        fun fill(intent: Intent, uri: Uri, mime: String, name: String?, share: Boolean) {
            val type = DownloadOpen.mimeType(name, mime)
            intent.setDataAndType(uri, type)
            intent.putExtra(EXTRA_URI, uri.toString())
            intent.putExtra(EXTRA_NAME, name ?: "")
            intent.putExtra(EXTRA_SHARE, share)
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }
}
