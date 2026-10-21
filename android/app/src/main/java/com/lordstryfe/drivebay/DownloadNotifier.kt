package com.lordstryfe.drivebay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat

class DownloadNotifier(private val context: Context) {
    private val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    fun ensureChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val progress = NotificationChannel(CHANNEL_PROGRESS, "Downloads", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Drivebay file downloads"
            setShowBadge(false)
        }
        val done = NotificationChannel(CHANNEL_DONE, "Finished downloads", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Open or share a file saved to Downloads/Drivebay"
        }
        manager.createNotificationChannel(progress)
        manager.createNotificationChannel(done)
    }

    fun placeholder(): Notification = base(CHANNEL_PROGRESS, "Drivebay", "Starting download")
        .setOngoing(true)
        .build()

    fun progress(job: DownloadJob, downloaded: Long, bytesPerSecond: Double, paused: Boolean, waitingWifi: Boolean): Notification {
        val total = job.totalBytes
        val text = when {
            waitingWifi -> "Waiting for Wi-Fi"
            paused -> "Paused"
            else -> DownloadPlan.statusLine(downloaded, total, bytesPerSecond)
        }
        val percent = if (total > 0L) ((downloaded * 100L) / total).toInt().coerceIn(0, 100) else 0
        val builder = base(CHANNEL_PROGRESS, job.fileName, text)
            .setOngoing(!paused)
            .setOnlyAlertOnce(true)
            .setProgress(100, percent, total <= 0L && !paused && !waitingWifi)
        if (paused) {
            builder.addAction(action("Resume", DrivebayDownloadService.ACTION_RESUME, job.id))
        } else {
            builder.addAction(action("Pause", DrivebayDownloadService.ACTION_PAUSE, job.id))
        }
        builder.addAction(action("Cancel", DrivebayDownloadService.ACTION_CANCEL, job.id))
        return builder.build()
    }

    fun failed(job: DownloadJob, message: String) {
        val builder = base(CHANNEL_DONE, job.fileName, message.ifBlank { "Download failed" })
            .setOngoing(false)
            .setAutoCancel(true)
            .addAction(action("Resume", DrivebayDownloadService.ACTION_RESUME, job.id))
            .addAction(action("Cancel", DrivebayDownloadService.ACTION_CANCEL, job.id))
        manager.notify(doneId(job.id), builder.build())
    }

    fun complete(job: DownloadJob, uri: Uri, mime: String) {
        manager.cancel(PROGRESS_ID)
        val type = DownloadOpen.mimeType(job.fileName, mime)
        val open = openIntent(uri, type, job.fileName, share = false)
        val share = openIntent(uri, type, job.fileName, share = true)
        val builder = base(CHANNEL_DONE, job.fileName, "Saved to Downloads/Drivebay")
            .setOngoing(false)
            .setAutoCancel(true)
            .setContentIntent(open)
            .addAction(android.R.drawable.ic_menu_view, "Open", open)
            .addAction(android.R.drawable.ic_menu_share, "Share", share)
        manager.notify(doneId(job.id), builder.build())
    }

    fun cancelProgress() {
        manager.cancel(PROGRESS_ID)
    }

    private fun base(channel: String, title: String, text: String): NotificationCompat.Builder {
        val openApp = PendingIntent.getActivity(
            context,
            1,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(context, channel)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(openApp)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
    }

    private fun action(label: String, action: String, id: String): NotificationCompat.Action {
        val intent = Intent(context, DrivebayDownloadService::class.java).apply {
            this.action = action
            putExtra(DrivebayDownloadService.EXTRA_ID, id)
        }
        val pending = PendingIntent.getService(
            context,
            (action + id).hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Action(0, label, pending)
    }

    private fun openIntent(uri: Uri, mime: String, name: String, share: Boolean): PendingIntent {
        val intent = Intent(context, DownloadOpenActivity::class.java).apply {
            DownloadOpenActivity.fill(this, uri, mime, name, share)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return PendingIntent.getActivity(
            context,
            (uri.toString() + share).hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun doneId(id: String): Int = id.hashCode()

    companion object {
        const val CHANNEL_PROGRESS = "drivebay_downloads"
        const val CHANNEL_DONE = "drivebay_downloads_done"
        const val PROGRESS_ID = 30
    }
}
