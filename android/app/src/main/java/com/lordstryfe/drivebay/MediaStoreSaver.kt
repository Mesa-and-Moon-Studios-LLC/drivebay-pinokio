package com.lordstryfe.drivebay

import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileInputStream

object MediaStoreSaver {
    const val FOLDER = "Drivebay"

    fun save(context: Context, temp: File, displayName: String, mime: String?): Uri {
        val safe = DownloadNames.safeFileName(displayName)
        val type = DownloadOpen.mimeType(safe, mime).let { typed ->
            if (typed != DownloadOpen.OCTET) typed else guessMime(safe)
        }
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveMediaStore(context, temp, safe, type)
        } else {
            saveLegacy(context, temp, safe, type)
        }
    }

    private fun saveMediaStore(context: Context, temp: File, name: String, mime: String): Uri {
        val resolver = context.contentResolver
        val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val relative = Environment.DIRECTORY_DOWNLOADS + "/" + FOLDER + "/"
        val unique = uniqueDisplayName(context, collection, relative, name)
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, unique)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, relative)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(collection, values) ?: error("Could not create Downloads/Drivebay/$unique")
        try {
            resolver.openOutputStream(uri)?.use { out ->
                FileInputStream(temp).use { input -> input.copyTo(out) }
            } ?: error("Could not write Downloads/Drivebay/$unique")
            val done = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
            resolver.update(uri, done, null, null)
            return uri
        } catch (err: Exception) {
            resolver.delete(uri, null, null)
            throw err
        }
    }

    @Suppress("DEPRECATION")
    private fun saveLegacy(context: Context, temp: File, name: String, mime: String): Uri {
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), FOLDER)
        if (!dir.exists() && !dir.mkdirs()) error("Could not create Downloads/Drivebay")
        val dest = uniqueFile(dir, name)
        FileInputStream(temp).use { input -> dest.outputStream().use { input.copyTo(it) } }
        MediaScannerConnection.scanFile(context, arrayOf(dest.absolutePath), arrayOf(mime), null)
        return FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", dest)
    }

    private fun uniqueDisplayName(context: Context, collection: Uri, relative: String, name: String): String {
        var candidate = name
        var index = 1
        while (nameTaken(context, collection, relative, candidate) && index < 1000) {
            candidate = numbered(name, index)
            index += 1
        }
        return candidate
    }

    private fun nameTaken(context: Context, collection: Uri, relative: String, name: String): Boolean {
        val projection = arrayOf(MediaStore.MediaColumns._ID)
        val selection = "${MediaStore.MediaColumns.DISPLAY_NAME}=? AND ${MediaStore.MediaColumns.RELATIVE_PATH}=?"
        context.contentResolver.query(collection, projection, selection, arrayOf(name, relative), null)?.use { cursor ->
            return cursor.moveToFirst()
        }
        return false
    }

    private fun uniqueFile(dir: File, name: String): File {
        var candidate = File(dir, name)
        var index = 1
        while (candidate.exists() && index < 1000) {
            candidate = File(dir, numbered(name, index))
            index += 1
        }
        return candidate
    }

    private fun numbered(name: String, index: Int): String {
        val dot = name.lastIndexOf('.')
        return if (dot > 0) {
            "${name.substring(0, dot)} ($index)${name.substring(dot)}"
        } else {
            "$name ($index)"
        }
    }

    private fun guessMime(name: String): String {
        val ext = name.substringAfterLast('.', "")
        if (ext.isBlank() || ext == name) return "application/octet-stream"
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.lowercase()) ?: "application/octet-stream"
    }
}
