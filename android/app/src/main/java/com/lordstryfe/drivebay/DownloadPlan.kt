package com.lordstryfe.drivebay

import java.util.Locale

/**
 * Chunk math, retry timing, and progress text. No Android APIs, so JVM tests can run it.
 */
object DownloadPlan {
    const val CHUNK_BYTES = 8 * 1024 * 1024
    const val LARGE_FILE_BYTES = 50L * 1024 * 1024
    const val MAX_CHUNK_ATTEMPTS = 5

    data class Chunk(val start: Long, val endInclusive: Long) {
        val length: Long get() = endInclusive - start + 1
    }

    data class ContentRange(val start: Long, val endInclusive: Long, val total: Long)

    fun nextChunk(offset: Long, size: Long, chunkBytes: Int = CHUNK_BYTES): Chunk? {
        if (size <= 0L || offset < 0L || offset >= size) return null
        val end = minOf(offset + chunkBytes.toLong() - 1L, size - 1L)
        return Chunk(offset, end)
    }

    fun rangeHeader(chunk: Chunk): String = "bytes=${chunk.start}-${chunk.endInclusive}"

    fun parseContentRange(header: String?): ContentRange? {
        if (header.isNullOrBlank()) return null
        val match = Regex("""bytes\s+(\d+)-(\d+)/(\d+|\*)""", RegexOption.IGNORE_CASE).find(header.trim())
            ?: return null
        val start = match.groupValues[1].toLongOrNull() ?: return null
        val end = match.groupValues[2].toLongOrNull() ?: return null
        if (end < start) return null
        val totalRaw = match.groupValues[3]
        val total = if (totalRaw == "*") -1L else totalRaw.toLongOrNull() ?: return null
        return ContentRange(start, end, total)
    }

    fun backoffMs(attempt: Int): Long {
        val exp = attempt.coerceIn(0, 4)
        return 1000L shl exp
    }

    fun isRetryableStatus(code: Int): Boolean = code == 408 || code == 429 || code >= 500

    fun bytesPerSecond(bytes: Long, elapsedMs: Long): Double {
        if (bytes <= 0L || elapsedMs <= 0L) return 0.0
        return bytes * 1000.0 / elapsedMs.toDouble()
    }

    fun etaMs(remainingBytes: Long, bytesPerSecond: Double): Long? {
        if (remainingBytes <= 0L) return 0L
        if (bytesPerSecond < 1.0) return null
        return (remainingBytes / bytesPerSecond * 1000.0).toLong()
    }

    fun formatRate(bytesPerSecond: Double): String {
        if (bytesPerSecond < 1024.0) return "${bytesPerSecond.toLong()} B/s"
        if (bytesPerSecond < 1024.0 * 1024.0) {
            return String.format(Locale.US, "%.1f KB/s", bytesPerSecond / 1024.0)
        }
        return String.format(Locale.US, "%.1f MB/s", bytesPerSecond / (1024.0 * 1024.0))
    }

    fun formatDuration(ms: Long): String {
        val seconds = (ms / 1000L).coerceAtLeast(0L)
        if (seconds < 60L) return "${seconds}s left"
        val minutes = seconds / 60L
        if (minutes < 60L) return "$minutes min left"
        val hours = minutes / 60L
        return "$hours h ${minutes % 60L} min left"
    }

    fun statusLine(downloaded: Long, total: Long, bytesPerSecond: Double): String {
        val speed = formatRate(bytesPerSecond)
        if (total <= 0L) return speed
        val eta = etaMs(total - downloaded, bytesPerSecond)
        val left = if (eta == null) "time left unavailable" else formatDuration(eta)
        return "$speed · $left"
    }
}
