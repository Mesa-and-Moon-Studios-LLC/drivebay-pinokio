package com.lordstryfe.drivebay

import android.app.Activity
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import com.google.android.material.button.MaterialButton

/**
 * Paused and incomplete downloads. The bytes already sit in the app's partial
 * files, and the server accepts Range, so Resume continues the same job.
 */
class DownloadsList(
    private val activity: Activity,
    private val onChanged: () -> Unit,
) {
    fun jobs(): List<DownloadJob> = DownloadsOrder.incomplete(DownloadRepository(activity).load())

    fun show() {
        val jobs = jobs()
        val density = activity.resources.displayMetrics.density
        val pad = (16 * density).toInt()
        val column = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        if (jobs.isEmpty()) {
            column.addView(TextView(activity).apply {
                text = activity.getString(R.string.downloads_empty)
                setTextColor(0xFFCBD5E1.toInt())
                textSize = 15f
            })
        }
        jobs.forEach { job -> column.addView(row(job, density)) }
        val scroll = ScrollView(activity).apply { addView(column) }
        AlertDialog.Builder(activity)
            .setTitle(R.string.downloads_title)
            .setView(scroll)
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun row(job: DownloadJob, density: Float): View {
        val column = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, (10 * density).toInt(), 0, (10 * density).toInt())
        }
        column.addView(TextView(activity).apply {
            text = job.fileName
            setTextColor(0xFFE8EEF7.toInt())
            textSize = 16f
        })
        val progress = if (job.totalBytes > 0L) {
            val pct = (100.0 * job.downloadedBytes / job.totalBytes).toInt().coerceIn(0, 100)
            "$pct%"
        } else ""
        column.addView(TextView(activity).apply {
            text = listOf(DownloadsOrder.label(job), progress).filter { it.isNotBlank() }.joinToString(" · ")
            setTextColor(0xFF94A3B8.toInt())
            textSize = 13f
        })
        val buttons = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL }
        if (job.state == DownloadJob.STATE_RUNNING || job.state == DownloadJob.STATE_QUEUED) {
            buttons.addView(button(activity.getString(R.string.download_pause)) {
                send(DrivebayDownloadService.ACTION_PAUSE, job.id)
            })
        } else {
            buttons.addView(button(activity.getString(R.string.download_resume)) {
                send(DrivebayDownloadService.ACTION_RESUME, job.id)
            })
        }
        buttons.addView(button(activity.getString(R.string.download_cancel)) {
            send(DrivebayDownloadService.ACTION_CANCEL, job.id)
        })
        column.addView(buttons)
        return column
    }

    private fun button(label: String, click: () -> Unit): MaterialButton =
        MaterialButton(activity, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = label
            isAllCaps = false
            setOnClickListener { click() }
        }

    private fun send(action: String, id: String) {
        val intent = android.content.Intent(activity, DrivebayDownloadService::class.java).apply {
            this.action = action
            putExtra(DrivebayDownloadService.EXTRA_ID, id)
        }
        androidx.core.content.ContextCompat.startForegroundService(activity, intent)
        activity.window.decorView.postDelayed(onChanged, 300)
    }
}
