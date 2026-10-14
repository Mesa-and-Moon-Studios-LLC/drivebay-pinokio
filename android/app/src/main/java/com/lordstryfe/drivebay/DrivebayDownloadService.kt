package com.lordstryfe.drivebay

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class DrivebayDownloadService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val gate = Mutex()
    private var pumping = false
    private val control = ConcurrentHashMap<String, String>()
    private lateinit var repository: DownloadRepository
    private lateinit var notifier: DownloadNotifier
    private val speeds = ConcurrentHashMap<String, Speed>()

    override fun onCreate() {
        super.onCreate()
        repository = DownloadRepository(this)
        notifier = DownloadNotifier(this)
        notifier.ensureChannels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startInForeground(notifier.placeholder())
        val action = intent?.action
        val id = intent?.getStringExtra(EXTRA_ID)
        when (action) {
            ACTION_ENQUEUE -> enqueue(intent)
            ACTION_PAUSE -> if (id != null) control[id] = "pause"
            ACTION_RESUME -> if (id != null) resume(id)
            ACTION_CANCEL -> if (id != null) control[id] = "cancel"
            ACTION_RESUME_INCOMPLETE -> Unit
        }
        kick()
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        if (repository.hasResumeWork()) {
            val restart = Intent(this, DrivebayDownloadService::class.java).apply { action = ACTION_RESUME_INCOMPLETE }
            try {
                ContextCompat.startForegroundService(this, restart)
            } catch (_: Exception) {
                /* The next time the app opens it continues from the temp file. */
            }
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun enqueue(intent: Intent) {
        val url = intent.getStringExtra(EXTRA_URL)?.trim().orEmpty()
        if (!url.startsWith("http://") && !url.startsWith("https://")) return
        val name = DownloadNames.fileNameFromDownloadUrl(url, intent.getStringExtra(EXTRA_NAME))
        val job = DownloadJob(
            id = UUID.randomUUID().toString(),
            url = url,
            fileName = name,
            cookie = intent.getStringExtra(EXTRA_COOKIE).orEmpty(),
            userAgent = intent.getStringExtra(EXTRA_UA).orEmpty(),
            totalBytes = intent.getLongExtra(EXTRA_SIZE, -1L).let { if (it > 0L) it else -1L },
            downloadedBytes = 0L,
            etag = null,
            mime = null,
            wifiOnly = intent.getBooleanExtra(EXTRA_WIFI, false),
            state = DownloadJob.STATE_QUEUED,
            error = null,
            createdAt = System.currentTimeMillis(),
        )
        repository.upsert(job)
    }

    private fun resume(id: String) {
        control.remove(id)
        val job = repository.load().firstOrNull { it.id == id } ?: return
        repository.upsert(job.copy(state = DownloadJob.STATE_QUEUED, error = null))
    }

    private fun kick() {
        scope.launch {
            gate.withLock {
                if (pumping) return@launch
                pumping = true
            }
            try {
                pump()
            } finally {
                gate.withLock { pumping = false }
                if (repository.hasRunnable(NetworkStatus.isOnWifi(this@DrivebayDownloadService))) {
                    kick()
                } else {
                    withContext(Dispatchers.Main) {
                        stopForeground(STOP_FOREGROUND_DETACH)
                        stopSelf()
                    }
                }
            }
        }
    }

    private suspend fun pump() {
        while (true) {
            val onWifi = NetworkStatus.isOnWifi(this)
            val job = repository.nextRunnable(onWifi) ?: break
            runJob(job)
        }
    }

    private suspend fun runJob(start: DownloadJob) {
        var job = start.copy(state = DownloadJob.STATE_RUNNING, error = null)
        repository.upsert(job)
        speeds.putIfAbsent(job.id, Speed())
        val partial = repository.partialFile(job.id)
        if (partial.exists() && partial.length() != job.downloadedBytes) {
            java.io.RandomAccessFile(partial, "rw").use { it.setLength(job.downloadedBytes.coerceAtLeast(0L)) }
        }
        var attempts = 0
        var restarted = false
        try {
            while (true) {
                when (control[job.id]) {
                    "cancel" -> {
                        control.remove(job.id)
                        repository.remove(job.id)
                        notifier.cancelProgress()
                        return
                    }
                    "pause" -> {
                        control.remove(job.id)
                        repository.upsert(job.copy(state = DownloadJob.STATE_PAUSED))
                        startInForeground(notifier.progress(job, job.downloadedBytes, 0.0, paused = true, waitingWifi = false))
                        return
                    }
                }
                if (job.wifiOnly && !NetworkStatus.isOnWifi(this)) {
                    startInForeground(notifier.progress(job, job.downloadedBytes, 0.0, paused = false, waitingWifi = true))
                    delay(2000)
                    continue
                }
                try {
                    if (job.totalBytes < 0L) {
                        val probe = ChunkDownloader.probe(job)
                        job = job.copy(totalBytes = probe.total, etag = probe.etag ?: job.etag, mime = probe.mime ?: job.mime)
                        repository.upsert(job)
                    }
                    if (job.totalBytes == 0L) break
                    val chunk = if (job.totalBytes > 0L) {
                        DownloadPlan.nextChunk(job.downloadedBytes, job.totalBytes)
                    } else {
                        DownloadPlan.Chunk(job.downloadedBytes, job.downloadedBytes + DownloadPlan.CHUNK_BYTES - 1)
                    }
                    if (chunk == null) break
                    val result = ChunkDownloader.fetchChunk(job, chunk, partial, onProgress = { wrote ->
                        val speed = speeds[job.id]?.note(job.downloadedBytes + wrote) ?: 0.0
                        startInForeground(notifier.progress(job, job.downloadedBytes + wrote, speed, paused = false, waitingWifi = false))
                    }, stop = { control[job.id] != null })
                    when (result) {
                        is ChunkResult.Restart -> {
                            if (restarted) throw DownloadHttpException(200, "The file changed on the PC. Download it again.")
                            restarted = true
                            partial.delete()
                            job = job.copy(downloadedBytes = 0L, totalBytes = result.total, etag = result.etag)
                            repository.upsert(job)
                            attempts = 0
                        }
                        is ChunkResult.Ok -> {
                            job = job.copy(
                                downloadedBytes = result.downloaded,
                                totalBytes = if (result.total >= 0) result.total else job.totalBytes,
                                etag = result.etag ?: job.etag,
                            )
                            repository.upsert(job)
                            attempts = 0
                            if (job.totalBytes >= 0L && job.downloadedBytes >= job.totalBytes) break
                        }
                    }
                } catch (stopped: DownloadStopped) {
                    continue
                } catch (http: DownloadHttpException) {
                    if (!DownloadPlan.isRetryableStatus(http.code)) throw http
                    attempts += 1
                    if (attempts >= DownloadPlan.MAX_CHUNK_ATTEMPTS) throw http
                    startInForeground(notifier.progress(job, job.downloadedBytes, 0.0, paused = false, waitingWifi = false))
                    delay(DownloadPlan.backoffMs(attempts - 1))
                } catch (io: java.io.IOException) {
                    attempts += 1
                    if (attempts >= DownloadPlan.MAX_CHUNK_ATTEMPTS) throw io
                    delay(DownloadPlan.backoffMs(attempts - 1))
                }
            }
            publish(job, partial)
        } catch (err: Exception) {
            val message = err.message ?: "Download failed"
            repository.upsert(job.copy(state = DownloadJob.STATE_FAILED, error = message))
            notifier.failed(job, message)
            notifier.cancelProgress()
        }
    }

    private fun publish(job: DownloadJob, partial: java.io.File) {
        if (!partial.exists()) partial.writeBytes(ByteArray(0))
        val uri = MediaStoreSaver.save(this, partial, job.fileName, job.mime)
        partial.delete()
        repository.remove(job.id)
        val mime = job.mime ?: "application/octet-stream"
        notifier.complete(job, uri, mime)
        sendBroadcast(
            Intent(ACTION_FINISHED).apply {
                setPackage(packageName)
                putExtra(EXTRA_NAME, job.fileName)
                putExtra(EXTRA_URI, uri.toString())
                putExtra(EXTRA_MIME, mime)
            },
        )
    }

    private fun startInForeground(notification: android.app.Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(DownloadNotifier.PROGRESS_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(DownloadNotifier.PROGRESS_ID, notification)
        }
    }

    private class Speed {
        private var lastBytes = 0L
        private var lastAt = 0L
        private var rate = 0.0
        fun note(downloaded: Long): Double {
            val now = System.currentTimeMillis()
            if (lastAt == 0L) {
                lastAt = now
                lastBytes = downloaded
                return 0.0
            }
            val dt = now - lastAt
            if (dt < 400L) return rate
            val instant = DownloadPlan.bytesPerSecond(downloaded - lastBytes, dt)
            rate = if (rate == 0.0) instant else rate * 0.7 + instant * 0.3
            lastAt = now
            lastBytes = downloaded
            return rate
        }
    }

    companion object {
        const val ACTION_ENQUEUE = "com.lordstryfe.drivebay.DOWNLOAD_ENQUEUE"
        const val ACTION_PAUSE = "com.lordstryfe.drivebay.DOWNLOAD_PAUSE"
        const val ACTION_RESUME = "com.lordstryfe.drivebay.DOWNLOAD_RESUME"
        const val ACTION_CANCEL = "com.lordstryfe.drivebay.DOWNLOAD_CANCEL"
        const val ACTION_RESUME_INCOMPLETE = "com.lordstryfe.drivebay.DOWNLOAD_RESUME_INCOMPLETE"
        const val ACTION_FINISHED = "com.lordstryfe.drivebay.DOWNLOAD_FINISHED"
        const val EXTRA_ID = "id"
        const val EXTRA_URL = "url"
        const val EXTRA_NAME = "name"
        const val EXTRA_COOKIE = "cookie"
        const val EXTRA_UA = "ua"
        const val EXTRA_SIZE = "size"
        const val EXTRA_WIFI = "wifi"
        const val EXTRA_URI = "uri"
        const val EXTRA_MIME = "mime"

        fun enqueue(context: Context, url: String, fileName: String, cookie: String, userAgent: String, size: Long, wifiOnly: Boolean) {
            val intent = Intent(context, DrivebayDownloadService::class.java).apply {
                action = ACTION_ENQUEUE
                putExtra(EXTRA_URL, url)
                putExtra(EXTRA_NAME, fileName)
                putExtra(EXTRA_COOKIE, cookie)
                putExtra(EXTRA_UA, userAgent)
                putExtra(EXTRA_SIZE, size)
                putExtra(EXTRA_WIFI, wifiOnly)
            }
            ContextCompat.startForegroundService(context, intent)
        }

        fun resumeIncomplete(context: Context) {
            if (!DownloadRepository(context).hasResumeWork()) return
            val intent = Intent(context, DrivebayDownloadService::class.java).apply { action = ACTION_RESUME_INCOMPLETE }
            try {
                ContextCompat.startForegroundService(context, intent)
            } catch (_: Exception) {
                /* Background start limits apply until the app is open. */
            }
        }
    }
}
