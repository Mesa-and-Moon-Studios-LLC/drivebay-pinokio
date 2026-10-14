package com.lordstryfe.drivebay

data class DownloadJob(
    val id: String,
    val url: String,
    val fileName: String,
    val cookie: String,
    val userAgent: String,
    val totalBytes: Long,
    val downloadedBytes: Long,
    val etag: String?,
    val mime: String?,
    val wifiOnly: Boolean,
    val state: String,
    val error: String?,
    val createdAt: Long,
) {
    fun runnable(): Boolean = state == STATE_QUEUED || state == STATE_RUNNING

    companion object {
        const val STATE_QUEUED = "queued"
        const val STATE_RUNNING = "running"
        const val STATE_PAUSED = "paused"
        const val STATE_FAILED = "failed"
    }
}
