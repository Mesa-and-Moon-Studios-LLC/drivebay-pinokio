package com.lordstryfe.drivebay

/**
 * Rules for opening a finished download in another app.
 *
 * Android's Intent.setData clears the MIME type, and setType clears the URI.
 * Assigning both as properties drops whichever was set first, so the Open
 * activity sees no file and returns without launching anything. [launchSlots]
 * is the shape that keeps both: one setDataAndType call.
 */
object DownloadOpen {
    const val OCTET = "application/octet-stream"
    const val NO_APP = "No app can open this file"

    enum class Step { CHOOSER, TOAST }

    /** What Open should do once the file URI and MIME are both present. */
    fun step(handlerCount: Int): Step = if (handlerCount > 0) Step.CHOOSER else Step.TOAST

    fun authority(packageName: String): String = "$packageName.fileprovider"

    fun isFileProviderUri(uri: String?, packageName: String): Boolean {
        if (uri.isNullOrBlank()) return false
        val prefix = "content://${authority(packageName)}/"
        return uri.startsWith(prefix) && !uri.contains("..")
    }

    /** A real Content-Type wins. A generic type falls through to the file name. */
    fun mimeType(fileName: String?, provided: String?): String {
        val given = provided?.substringBefore(';')?.trim()?.lowercase().orEmpty()
        if (given.isNotEmpty() && given != OCTET && given != "*/*") return given
        return mimeFromName(fileName)
    }

    fun mimeFromName(fileName: String?): String {
        val ext = extension(fileName)
        return TYPES[ext] ?: OCTET
    }

    /** Cache file under open/, with no path separators. */
    fun cacheFileName(displayName: String, sourceUri: String): String {
        val safe = DownloadNames.safeFileName(displayName)
        val tag = tagOf(sourceUri)
        val dot = safe.lastIndexOf('.')
        return if (dot > 0) {
            "${safe.substring(0, dot)}-$tag${safe.substring(dot)}"
        } else {
            "$safe-$tag"
        }
    }

    /** Models setData / setType / setDataAndType. Tests use this instead of android.content.Intent. */
    fun launchSlots(uri: String, mime: String): IntentSlots = IntentSlots().apply { setDataAndType(uri, mime) }

    private fun extension(fileName: String?): String {
        val base = fileName?.substringAfterLast('/')?.substringAfterLast('\\')?.trim().orEmpty()
        val ext = base.substringAfterLast('.', "")
        if (ext.isBlank() || ext == base) return ""
        return ext.lowercase()
    }

    private fun tagOf(sourceUri: String): String {
        var acc = 0
        for (b in sourceUri.toByteArray(Charsets.UTF_8)) acc = (acc * 31 + b.toInt()) and 0x7fffffff
        return acc.toString(16)
    }

    private val TYPES = mapOf(
        "pdf" to "application/pdf",
        "png" to "image/png",
        "jpg" to "image/jpeg",
        "jpeg" to "image/jpeg",
        "gif" to "image/gif",
        "webp" to "image/webp",
        "heic" to "image/heic",
        "txt" to "text/plain",
        "csv" to "text/csv",
        "json" to "application/json",
        "html" to "text/html",
        "htm" to "text/html",
        "mp4" to "video/mp4",
        "mov" to "video/quicktime",
        "mp3" to "audio/mpeg",
        "m4a" to "audio/mp4",
        "wav" to "audio/wav",
        "zip" to "application/zip",
        "apk" to "application/vnd.android.package-archive",
        "doc" to "application/msword",
        "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" to "application/vnd.ms-excel",
        "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" to "application/vnd.ms-powerpoint",
        "pptx" to "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    )
}

/** Same clearing rules as android.content.Intent. */
class IntentSlots {
    var data: String? = null
    var type: String? = null

    fun assignData(uri: String?) {
        data = uri
        type = null
    }

    fun assignType(mime: String?) {
        type = mime
        data = null
    }

    fun setDataAndType(uri: String?, mime: String?) {
        data = uri
        type = mime
    }
}
