package com.lordstryfe.drivebay

import java.io.File
import java.io.InputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL

class DownloadStopped : Exception()

class DownloadHttpException(val code: Int, message: String) : Exception(message)

data class Probe(val total: Long, val etag: String?, val mime: String?)

sealed class ChunkResult {
    data class Ok(val downloaded: Long, val total: Long, val etag: String?) : ChunkResult()
    data class Restart(val total: Long, val etag: String?) : ChunkResult()
}

object ChunkDownloader {
    private const val CONNECT_MS = 20_000
    private const val READ_MS = 45_000

    fun probe(job: DownloadJob): Probe {
        try {
            val head = open(job, "HEAD", null)
            try {
                val code = head.responseCode
                if (code == 401 || code == 403 || code == 404) {
                    throw DownloadHttpException(code, messageFor(code, head))
                }
                if (code in 200..299) {
                    val length = head.getHeaderField("Content-Length")?.toLongOrNull()
                    if (length != null) {
                        return Probe(length, head.getHeaderField("ETag"), cleanMime(head.contentType))
                    }
                }
            } finally {
                head.disconnect()
            }
        } catch (http: DownloadHttpException) {
            throw http
        } catch (_: Exception) {
            /* Some servers reject HEAD. A one-byte range still reports the size. */
        }
        val ranged = open(job, "GET", "bytes=0-0")
        try {
            val code = ranged.responseCode
            val parsed = DownloadPlan.parseContentRange(ranged.getHeaderField("Content-Range"))
            val total = parsed?.total ?: ranged.getHeaderField("Content-Length")?.toLongOrNull() ?: -1L
            if (code == 206 || code == 200) {
                return Probe(total, ranged.getHeaderField("ETag"), cleanMime(ranged.contentType))
            }
            throw DownloadHttpException(code, messageFor(code, ranged))
        } finally {
            ranged.disconnect()
        }
    }

    fun fetchChunk(
        job: DownloadJob,
        chunk: DownloadPlan.Chunk,
        partial: File,
        onProgress: (Long) -> Unit,
        stop: () -> Boolean,
    ): ChunkResult {
        val conn = open(job, "GET", DownloadPlan.rangeHeader(chunk))
        if (!job.etag.isNullOrBlank()) {
            conn.setRequestProperty("If-Range", job.etag)
        }
        try {
            val code = conn.responseCode
            if (code == 206) {
                val range = DownloadPlan.parseContentRange(conn.getHeaderField("Content-Range"))
                if (range != null && range.start != chunk.start) {
                    throw DownloadHttpException(206, "Server returned the wrong byte range")
                }
                val total = range?.total?.takeIf { it >= 0 } ?: job.totalBytes
                val wrote = writeStream(partial, chunk.start, conn.inputStream, chunk.length, onProgress, stop)
                if (wrote != chunk.length) {
                    throw DownloadHttpException(206, "Connection dropped during this chunk")
                }
                return ChunkResult.Ok(chunk.start + wrote, total, conn.getHeaderField("ETag") ?: job.etag)
            }
            if (code == 200) {
                if (chunk.start > 0L) {
                    conn.inputStream?.close()
                    val total = conn.getHeaderField("Content-Length")?.toLongOrNull() ?: -1L
                    return ChunkResult.Restart(total, conn.getHeaderField("ETag"))
                }
                val declared = conn.getHeaderField("Content-Length")?.toLongOrNull()
                val wrote = writeStream(partial, 0L, conn.inputStream, declared ?: Long.MAX_VALUE, onProgress, stop)
                val total = declared ?: wrote
                return ChunkResult.Ok(wrote, total, conn.getHeaderField("ETag") ?: job.etag)
            }
            val detail = conn.errorStream?.bufferedReader()?.use { it.readText() }?.take(180).orEmpty()
            throw DownloadHttpException(code, if (detail.isBlank()) "Download failed ($code)" else detail)
        } finally {
            conn.disconnect()
        }
    }

    private fun open(job: DownloadJob, method: String, range: String?): HttpURLConnection {
        val conn = (URL(job.url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            instanceFollowRedirects = true
            useCaches = false
            connectTimeout = CONNECT_MS
            readTimeout = READ_MS
            setRequestProperty("Accept-Encoding", "identity")
            setRequestProperty("Accept", "*/*")
            if (job.userAgent.isNotBlank()) setRequestProperty("User-Agent", job.userAgent)
            if (job.cookie.isNotBlank()) setRequestProperty("Cookie", job.cookie)
            if (!range.isNullOrBlank()) setRequestProperty("Range", range)
        }
        return conn
    }

    private fun writeStream(
        partial: File,
        start: Long,
        input: InputStream,
        expected: Long,
        onProgress: (Long) -> Unit,
        stop: () -> Boolean,
    ): Long {
        partial.parentFile?.mkdirs()
        RandomAccessFile(partial, "rw").use { file ->
            if (file.length() != start) file.setLength(start)
            file.seek(start)
            val buffer = ByteArray(64 * 1024)
            var got = 0L
            var lastNotify = 0L
            while (got < expected) {
                if (stop()) throw DownloadStopped()
                val want = minOf(buffer.size.toLong(), expected - got).toInt()
                val read = input.read(buffer, 0, want)
                if (read < 0) break
                file.write(buffer, 0, read)
                got += read
                if (got - lastNotify >= 256 * 1024 || got >= expected) {
                    onProgress(got)
                    lastNotify = got
                }
            }
            file.fd.sync()
            onProgress(got)
            return got
        }
    }

    private fun messageFor(code: Int, conn: HttpURLConnection): String {
        val detail = conn.errorStream?.bufferedReader()?.use { it.readText() }?.take(180).orEmpty()
        if (code == 401 || code == 403) return "Sign in on the phone, then try the download again"
        return if (detail.isBlank()) "Download failed ($code)" else detail
    }

    private fun cleanMime(raw: String?): String? {
        val mime = raw?.substringBefore(';')?.trim().orEmpty()
        return mime.ifBlank { null }
    }
}
