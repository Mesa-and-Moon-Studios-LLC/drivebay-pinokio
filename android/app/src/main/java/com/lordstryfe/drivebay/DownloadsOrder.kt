package com.lordstryfe.drivebay

/** Which saved downloads still need the user. Finished jobs are removed from the store. */
object DownloadsOrder {
    fun incomplete(jobs: List<DownloadJob>): List<DownloadJob> =
        jobs.filter {
            it.state == DownloadJob.STATE_PAUSED ||
                it.state == DownloadJob.STATE_FAILED ||
                it.state == DownloadJob.STATE_QUEUED ||
                it.state == DownloadJob.STATE_RUNNING
        }.sortedByDescending { it.createdAt }

    fun needsAttention(jobs: List<DownloadJob>): Int = incomplete(jobs).size

    fun label(job: DownloadJob): String = when (job.state) {
        DownloadJob.STATE_PAUSED -> "Paused"
        DownloadJob.STATE_FAILED -> job.error?.let { "Failed: $it" } ?: "Failed"
        DownloadJob.STATE_RUNNING -> "Downloading"
        DownloadJob.STATE_QUEUED -> if (job.wifiOnly) "Waiting for Wi-Fi" else "Queued"
        else -> job.state
    }
}
