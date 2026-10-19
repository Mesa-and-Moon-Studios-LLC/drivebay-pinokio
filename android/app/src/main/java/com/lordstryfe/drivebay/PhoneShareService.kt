package com.lordstryfe.drivebay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.net.NetworkInterface
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * Optional WebDAV server. Off until the user turns it on.
 * It binds only to Tailscale and private LAN addresses.
 */
class PhoneShareService : Service() {
    @Volatile private var server: PhoneDavServer? = null
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "drivebay-phone-share").apply { isDaemon = true } }
    private val generation = AtomicInteger(0)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            shutdown(null)
            return START_NOT_STICKY
        }
        return try {
            startSharing()
        } catch (e: Exception) {
            // Never take the whole app down from here. Record it and tell the screen.
            CrashLog.record(this, "Phone-as-drive service start", e)
            shutdown(friendlyError(e))
            START_NOT_STICKY
        }
    }

    private fun startSharing(): Int {
        val store = PhoneShareStore(this)
        val hosts = runCatching { shareHosts() }.getOrDefault(emptyList())
        // Started with startForegroundService(): call startForeground() before any early return,
        // or Android kills the app with ForegroundServiceDidNotStartInTimeException.
        val foregroundError = enterForeground(notification(hosts))
        if (foregroundError != null) {
            CrashLog.record(this, "Phone-as-drive startForeground", foregroundError)
            // Usually Android refusing a start from the background. Keep the setting; the app retries when opened.
            shutdown(friendlyError(foregroundError), keepEnabled = true)
            return START_NOT_STICKY
        }
        val hash = store.tokenHash()
        val folders = store.folders()
        val wholePhone = store.wholePhone()
        if (!store.enabled() || hash == null || (!wholePhone && folders.isEmpty())) {
            shutdown(null)
            return START_NOT_STICKY
        }
        if (hosts.isEmpty()) {
            stopServer()
            broadcast(emptyList())
            return START_STICKY
        }
        val ticket = generation.incrementAndGet()
        // Opening the folders and binding port 8780 happens off the main thread.
        worker.execute { openServer(ticket, folders, wholePhone, hash, hosts) }
        return START_STICKY
    }

    private fun openServer(ticket: Int, folders: List<SharedFolder>, wholePhone: Boolean, hash: String, hosts: List<String>) {
        if (ticket != generation.get()) return
        var dav: PhoneDavServer? = null
        try {
            val docs: DavStore = if (wholePhone) {
                if (!hasAllFilesAccess()) throw AllFilesAccessException()
                val files = FilePhoneStore(Environment.getExternalStorageDirectory()) { hasAllFilesAccess() }
                if (!files.usable()) throw AllFilesAccessException()
                files
            } else {
                DocumentPhoneStore(this, folders).also { if (it.rootCount() == 0) throw FolderAccessException() }
            }
            stopServer()
            val codeState = PhoneShareStore(this)
            dav = PhoneDavServer(docs, hash, PORT, hosts, codeState) {
                // Five wrong codes: tell the screen so it can show "Code locked".
                broadcast(hosts)
            }
            dav.start()
            if (ticket != generation.get()) {
                dav.stop()
                return
            }
            server = dav
            broadcast(hosts)
        } catch (e: Exception) {
            dav?.stop()
            CrashLog.record(this, "Phone-as-drive server start", e)
            val message = friendlyError(e)
            Handler(Looper.getMainLooper()).post { shutdown(message) }
        }
    }

    override fun onDestroy() {
        generation.incrementAndGet()
        stopServer()
        broadcast(emptyList())
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun stopServer() {
        val running = server
        server = null
        running?.stop()
    }

    /** Stops sharing. With an error, sharing is switched off so it does not retry on every launch. */
    private fun shutdown(error: String?, keepEnabled: Boolean = false) {
        generation.incrementAndGet()
        stopServer()
        if (error != null && !keepEnabled) runCatching { PhoneShareStore(this).setEnabled(false) }
        broadcast(emptyList(), error)
        runCatching {
            if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
        }
        stopSelf()
    }

    private fun friendlyError(e: Throwable): String = when (e) {
        is FolderAccessException -> getString(R.string.phone_share_err_folder)
        is AllFilesAccessException -> getString(R.string.phone_share_err_all_files)
        is java.net.BindException -> getString(R.string.phone_share_err_port, PORT)
        is SecurityException -> getString(R.string.phone_share_err_permission)
        else -> getString(R.string.phone_share_err_generic, e.javaClass.simpleName)
    }

    private class FolderAccessException : Exception("None of the chosen folders can be opened")

    private class AllFilesAccessException : Exception("All files access is not granted")

    /** Re-checked on every request; if it's revoked mid-share, stop the service cleanly. */
    private fun hasAllFilesAccess(): Boolean {
        val ok = PhoneShareService.allFilesAccess()
        if (!ok && server != null) {
            Handler(Looper.getMainLooper()).post { if (server != null) shutdown(getString(R.string.phone_share_err_all_files)) }
        }
        return ok
    }

    private fun notification(hosts: List<String>): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "Phone as drive", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while this phone is shared as a drive"
                },
            )
        }
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val where = hosts.firstOrNull()?.let { "http://$it:$PORT/" } ?: "Waiting for Tailscale or Wi-Fi"
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(getString(R.string.phone_share_on))
            .setContentText(where)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    /** Returns the failure instead of throwing, so the caller can stop cleanly. */
    private fun enterForeground(notification: Notification): Exception? = try {
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        null
    } catch (e: Exception) {
        e
    }

    private fun broadcast(hosts: List<String>, error: String? = null) {
        runCatching {
            sendBroadcast(
                Intent(ACTION_STATE).apply {
                    setPackage(packageName)
                    putExtra(EXTRA_HOSTS, hosts.joinToString(","))
                    if (error != null) putExtra(EXTRA_ERROR, error)
                },
            )
        }
    }

    companion object {
        const val PORT = 8780
        const val ACTION_START = "com.lordstryfe.drivebay.PHONE_SHARE_START"
        const val ACTION_STOP = "com.lordstryfe.drivebay.PHONE_SHARE_STOP"
        const val ACTION_STATE = "com.lordstryfe.drivebay.PHONE_SHARE_STATE"
        const val EXTRA_HOSTS = "hosts"
        const val EXTRA_ERROR = "error"
        private const val CHANNEL = "phone_share"
        private const val NOTIFICATION_ID = 44

        /** True when Android granted All files access (Android 11+), or storage is open on older versions. */
        fun allFilesAccess(): Boolean = try {
            if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager() else false
        } catch (_: Exception) {
            false
        }

        fun shareHosts(): List<String> {
            val out = linkedSetOf<String>()
            val interfaces = NetworkInterface.getNetworkInterfaces() ?: return emptyList()
            while (interfaces.hasMoreElements()) {
                val nic = interfaces.nextElement()
                val addresses = nic.inetAddresses ?: continue
                while (addresses.hasMoreElements()) {
                    val raw = addresses.nextElement().hostAddress?.substringBefore('%') ?: continue
                    if (raw.startsWith("127.")) continue
                    if (PhoneShareNet.isPrivateOrTailscale(raw) && !raw.contains(':')) out += raw
                }
            }
            return out.toList()
        }

        /** Returns null on success, or the reason it could not start. Never throws. */
        fun start(context: Context): Exception? {
            val intent = Intent(context, PhoneShareService::class.java).apply { action = ACTION_START }
            return try {
                ContextCompat.startForegroundService(context, intent)
                null
            } catch (e: Exception) {
                CrashLog.record(context, "Phone-as-drive startForegroundService", e)
                e
            }
        }

        fun stop(context: Context) {
            // stopService, not startForegroundService: a foreground start that never calls
            // startForeground() is itself a crash on Android 8+.
            runCatching { context.stopService(Intent(context, PhoneShareService::class.java)) }
        }
    }
}
