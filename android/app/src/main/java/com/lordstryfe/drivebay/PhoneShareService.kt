package com.lordstryfe.drivebay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * WebDAV share for the folders the user picked, or the whole phone if they opted in.
 * Off until they turn it on. The token hash, 6-digit code, and folder list live in
 * [PhoneShareStore], so a killed or restarted process can bind again without a new token.
 * The foreground service is not started from [android.app.Application.onCreate]: a
 * background process start throws ForegroundServiceStartNotAllowedException.
 * [MainActivity] resumes it from onResume. A reboot resumes it only when this
 * service's foreground type is allowed from BOOT_COMPLETED; otherwise a notification
 * asks the user to tap. Opening folders and binding port 8780 happens on a background
 * thread. A missing Tailscale or LAN address is retried with backoff, and a new address
 * is added without dropping the sockets that are already up.
 */
class PhoneShareService : Service() {
    @Volatile private var server: PhoneDavServer? = null
    private val serverLock = Any()
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "drivebay-phone-share").apply { isDaemon = true } }
    private val generation = AtomicInteger(0)
    private var servedKey: String? = null
    private var attempt = 0
    private var portInUseFailures = 0
    @Volatile private var stopping = false
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var multicast: WifiManager.MulticastLock? = null
    private var discovery: DatagramSocket? = null
    private val discoveryStarting = AtomicBoolean(false)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val refreshRunnable = Runnable { refreshServer() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        PhoneShareStore(this).setListening(emptyList())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            runCatching { enterForeground(notification(emptyList())) }
            shutdown(null)
            return START_NOT_STICKY
        }
        return try {
            startSharing()
        } catch (e: Exception) {
            if (!PhoneShareLifecycle.isForegroundStartBlocked(e)) {
                CrashLog.record(this, "Phone-as-drive service start", e)
            }
            shutdown(if (PhoneShareLifecycle.isForegroundStartBlocked(e)) null else friendlyError(e), keepEnabled = PhoneShareLifecycle.isForegroundStartBlocked(e))
            START_NOT_STICKY
        }
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Swiping the app away must not drop the share. stopWithTask is false.
        super.onTaskRemoved(rootIntent)
    }

    private fun startSharing(): Int {
        stopping = false
        portInUseFailures = 0
        val hosts = runCatching { shareHosts() }.getOrDefault(emptyList())
        // Started with startForegroundService(): call startForeground() before any early return,
        // or Android kills the app with ForegroundServiceDidNotStartInTimeException.
        val foregroundError = enterForeground(notification(server?.boundHosts().orEmpty().ifEmpty { hosts }))
        if (foregroundError != null) {
            if (!PhoneShareLifecycle.isForegroundStartBlocked(foregroundError)) {
                CrashLog.record(this, "Phone-as-drive startForeground", foregroundError)
            }
            shutdown(if (PhoneShareLifecycle.isForegroundStartBlocked(foregroundError)) null else friendlyError(foregroundError), keepEnabled = true)
            return START_NOT_STICKY
        }
        val store = PhoneShareStore(this)
        if (!PhoneShareLifecycle.shouldResume(store.enabled(), store.tokenHash(), store.folders().size, store.wholePhone())) {
            shutdown(null)
            return START_NOT_STICKY
        }
        listenForNetworks()
        ensureDiscovery()
        refreshServer()
        return START_STICKY
    }

    /** Queue a background check. Empty or changed addresses retry; a healthy bind just waits. */
    private fun refreshServer() {
        if (stopping) return
        ensureDiscovery()
        val store = PhoneShareStore(this)
        val hash = store.tokenHash()
        val folders = store.folders()
        val wholePhone = store.wholePhone()
        if (!PhoneShareLifecycle.shouldResume(store.enabled(), hash, folders.size, wholePhone)) {
            shutdown(null)
            return
        }
        val hosts = runCatching { shareHosts() }.getOrDefault(emptyList())
        val ticket = generation.incrementAndGet()
        try {
            worker.execute { openServer(ticket, folders, wholePhone, hash!!, hosts) }
        } catch (e: Exception) {
            CrashLog.record(this, "Phone-as-drive server start", e)
            noteRetry()
        }
    }

    private fun openServer(ticket: Int, folders: List<SharedFolder>, wholePhone: Boolean, hash: String, hosts: List<String>) {
        if (ticket != generation.get() || stopping) return
        try {
            val key = shareKey(wholePhone, folders, hash)
            val bound = server?.boundHosts().orEmpty()
            val missing = hosts.filter { want -> bound.none { it.equals(want, ignoreCase = true) } }
            if (server != null && servedKey == key && bound.isNotEmpty() && missing.isEmpty()) {
                if (ticket != generation.get()) return
                onMain {
                    attempt = 0
                    portInUseFailures = 0
                    PhoneShareStore(this).setListening(bound)
                    broadcast(bound)
                    schedule(PhoneShareLifecycle.HEALTHY_POLL_MS)
                }
                return
            }
            if (server != null && servedKey == key && bound.isNotEmpty()) {
                server?.bindMore(missing)
                val now = server?.boundHosts().orEmpty()
                if (ticket != generation.get()) return
                val stillMissing = hosts.filter { want -> now.none { it.equals(want, ignoreCase = true) } }
                onMain {
                    PhoneShareStore(this).setListening(now)
                    broadcast(now)
                    enterForeground(notification(now))
                    if (stillMissing.isEmpty()) {
                        attempt = 0
                        portInUseFailures = 0
                    } else attempt++
                    schedule(if (stillMissing.isEmpty()) PhoneShareLifecycle.HEALTHY_POLL_MS else PhoneShareLifecycle.retryDelayMs(attempt))
                }
                return
            }
            if (hosts.isEmpty()) {
                stopServer()
                if (ticket != generation.get()) return
                onMain {
                    PhoneShareStore(this).setListening(emptyList())
                    broadcast(emptyList())
                    enterForeground(notification(emptyList()))
                    attempt++
                    schedule(PhoneShareLifecycle.retryDelayMs(attempt))
                }
                return
            }
            val docs = openStore(folders, wholePhone)
            stopServer()
            val dav = PhoneDavServer(
                docs,
                hash,
                PORT,
                hosts,
                PhoneShareLifecycle.peerId(hash),
                PhoneShareStore(this),
            ) {
                val listening = server?.boundHosts().orEmpty()
                onMain { broadcast(listening) }
            }
            dav.start()
            val listening = dav.boundHosts()
            val published = synchronized(serverLock) {
                if (ticket != generation.get() || stopping) {
                    dav.stop()
                    false
                } else {
                    server = dav
                    servedKey = key
                    true
                }
            }
            if (!published) return
            onMain {
                attempt = 0
                portInUseFailures = 0
                PhoneShareStore(this).setListening(listening)
                broadcast(listening)
                enterForeground(notification(listening))
                schedule(PhoneShareLifecycle.HEALTHY_POLL_MS)
            }
        } catch (e: Exception) {
            if (ticket != generation.get() || stopping) return
            when {
                e is FolderAccessException || e is AllFilesAccessException -> {
                    CrashLog.record(this, "Phone-as-drive server start", e)
                    val message = friendlyError(e)
                    onMain { shutdown(message) }
                }
                PhoneShareLifecycle.isAddressInUse(e) -> onMain { notePortInUse(e) }
                else -> {
                    CrashLog.record(this, "Phone-as-drive server start", e)
                    onMain { noteRetry() }
                }
            }
        }
    }

    private fun openStore(folders: List<SharedFolder>, wholePhone: Boolean): DavStore {
        return if (wholePhone) {
            if (!hasAllFilesAccess()) throw AllFilesAccessException()
            val files = FilePhoneStore(Environment.getExternalStorageDirectory()) { hasAllFilesAccess() }
            if (!files.usable()) throw AllFilesAccessException()
            files
        } else {
            DocumentPhoneStore(this, folders).also { if (it.rootCount() == 0) throw FolderAccessException() }
        }
    }

    private fun shareKey(wholePhone: Boolean, folders: List<SharedFolder>, hash: String): String =
        "$wholePhone|$hash|" + folders.joinToString("|") { it.uri }

    private fun noteRetry() {
        if (stopping) return
        PhoneShareStore(this).setListening(emptyList())
        broadcast(emptyList())
        enterForeground(notification(emptyList()))
        attempt++
        schedule(PhoneShareLifecycle.retryDelayMs(attempt))
    }

    /**
     * The previous listen socket, or another app, still has port 8780.
     * Try a few times with backoff. Then turn sharing off and say why.
     */
    private fun notePortInUse(error: Exception) {
        if (stopping) return
        portInUseFailures++
        PhoneShareStore(this).setListening(emptyList())
        if (PhoneShareLifecycle.portInUseExhausted(portInUseFailures)) {
            CrashLog.record(this, "Phone-as-drive port in use", error)
            shutdown(getString(R.string.phone_share_err_port, PORT))
            return
        }
        val detail = getString(R.string.phone_share_port_retry, PORT)
        broadcast(emptyList(), detail = detail)
        enterForeground(notification(emptyList(), detail))
        schedule(PhoneShareLifecycle.retryDelayMs(portInUseFailures - 1))
    }

    private fun schedule(delayMs: Long) {
        mainHandler.removeCallbacks(refreshRunnable)
        if (!stopping) mainHandler.postDelayed(refreshRunnable, delayMs)
    }

    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post(block)
    }

    override fun onDestroy() {
        synchronized(serverLock) {
            stopping = true
            generation.incrementAndGet()
            mainHandler.removeCallbacks(refreshRunnable)
            val running = server
            server = null
            servedKey = null
            running?.stop()
        }
        PhoneShareStore(this).setListening(emptyList())
        broadcast(emptyList())
        closeDiscovery()
        val callback = networkCallback
        networkCallback = null
        if (callback != null) {
            runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(callback) }
        }
        multicast?.let { lock -> if (lock.isHeld) runCatching { lock.release() } }
        multicast = null
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun stopServer() {
        synchronized(serverLock) {
            val running = server
            server = null
            servedKey = null
            running?.stop()
        }
    }

    /** Stops sharing. With an error the user must act on, sharing is switched off. */
    private fun shutdown(error: String?, keepEnabled: Boolean = false) {
        synchronized(serverLock) {
            stopping = true
            generation.incrementAndGet()
            mainHandler.removeCallbacks(refreshRunnable)
        }
        stopServer()
        if (error != null && !keepEnabled) runCatching { PhoneShareStore(this).setEnabled(false) }
        PhoneShareStore(this).setListening(emptyList())
        broadcast(emptyList(), error)
        closeDiscovery()
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
            onMain { if (server != null) shutdown(getString(R.string.phone_share_err_all_files)) }
        }
        return ok
    }

    private fun listenForNetworks() {
        if (networkCallback != null) return
        val manager = getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                mainHandler.post { refreshServer() }
            }

            override fun onLost(network: Network) {
                mainHandler.post { refreshServer() }
            }
        }
        try {
            manager.registerDefaultNetworkCallback(callback)
            networkCallback = callback
        } catch (e: Exception) {
            CrashLog.record(this, "Phone-as-drive network callback", e)
        }
    }

    private fun ensureDiscovery() {
        if (discovery?.isClosed == false) return
        if (!discoveryStarting.compareAndSet(false, true)) return
        acquireMulticast()
        Thread({
            val socket = DatagramSocket(null)
            socket.reuseAddress = true
            try {
                socket.bind(InetSocketAddress(PhoneShareLifecycle.DISCOVERY_PORT))
            } catch (e: Exception) {
                socket.close()
                discoveryStarting.set(false)
                CrashLog.record(this, "Phone-as-drive discovery", e)
                return@Thread
            }
            discovery = socket
            val buf = ByteArray(256)
            while (!socket.isClosed && !stopping) {
                val packet = DatagramPacket(buf, buf.size)
                try {
                    socket.receive(packet)
                } catch (_: Exception) {
                    break
                }
                val text = String(packet.data, 0, packet.length, Charsets.US_ASCII).trim()
                if (text != PhoneShareLifecycle.DISCOVERY_QUERY) continue
                val hash = PhoneShareStore(this).tokenHash() ?: continue
                val peer = PhoneShareLifecycle.peerId(hash) ?: continue
                val msg = PhoneShareLifecycle.discoveryMessage(peer, PORT).toByteArray(Charsets.US_ASCII)
                val reply = DatagramPacket(msg, msg.size, packet.address, packet.port)
                try {
                    socket.send(reply)
                } catch (_: Exception) {
                }
            }
            if (discovery == socket) discovery = null
            discoveryStarting.set(false)
        }, "drivebay-phone-discovery").apply { isDaemon = true }.start()
    }

    private fun acquireMulticast() {
        if (multicast?.isHeld == true) return
        val wifi = applicationContext.getSystemService(WIFI_SERVICE) as? WifiManager ?: return
        val lock = wifi.createMulticastLock("drivebay-phone")
        lock.setReferenceCounted(false)
        try {
            lock.acquire()
            multicast = lock
        } catch (e: Exception) {
            CrashLog.record(this, "Phone-as-drive multicast", e)
        }
    }

    private fun closeDiscovery() {
        discoveryStarting.set(false)
        val socket = discovery
        discovery = null
        if (socket != null) runCatching { socket.close() }
    }

    private fun notification(hosts: List<String>, status: String? = null): Notification {
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
        val where = status?.takeIf { it.isNotBlank() }
            ?: hosts.firstOrNull()?.let { "http://$it:$PORT/" }
            ?: getString(R.string.phone_share_reconnecting)
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

    private fun broadcast(hosts: List<String>, error: String? = null, detail: String? = null) {
        runCatching {
            sendBroadcast(
                Intent(ACTION_STATE).apply {
                    setPackage(packageName)
                    putExtra(EXTRA_HOSTS, hosts.joinToString(","))
                    if (error != null) putExtra(EXTRA_ERROR, error)
                    if (detail != null) putExtra(EXTRA_DETAIL, detail)
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
        const val EXTRA_DETAIL = "detail"
        const val ACTION_RESUME = "com.lordstryfe.drivebay.PHONE_SHARE_RESUME"
        private const val CHANNEL = "phone_share"
        private const val RESUME_CHANNEL = "phone_share_resume"
        private const val NOTIFICATION_ID = 44
        private const val RESUME_NOTIFICATION_ID = 45

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

        fun resumeIfEnabled(context: Context, origin: PhoneShareLifecycle.ShareStartOrigin) {
            val store = PhoneShareStore(context)
            if (!PhoneShareLifecycle.shouldResume(store.enabled(), store.tokenHash(), store.folders().size, store.wholePhone())) {
                cancelResumeNotification(context)
                return
            }
            val targetSdk = runCatching { context.applicationInfo.targetSdkVersion }.getOrDefault(36)
            if (!PhoneShareLifecycle.allowsForegroundStart(origin, PhoneShareLifecycle.FOREGROUND_SERVICE_TYPES, targetSdk)) {
                showResumeNotification(context)
                return
            }
            start(context)
        }

        /**
         * Returns null when the service was started, or when Android refused a background start.
         * A refusal is not a failure: it posts "Tap to resume phone sharing" and is not logged.
         * Never throws.
         */
        fun start(context: Context): Exception? {
            val intent = Intent(context, PhoneShareService::class.java).apply { action = ACTION_START }
            return try {
                ContextCompat.startForegroundService(context, intent)
                cancelResumeNotification(context)
                null
            } catch (e: Exception) {
                if (PhoneShareLifecycle.isForegroundStartBlocked(e)) {
                    showResumeNotification(context)
                    null
                } else {
                    CrashLog.record(context, "Phone-as-drive startForegroundService", e)
                    e
                }
            }
        }

        fun stop(context: Context) {
            cancelResumeNotification(context)
            // stopService, not startForegroundService: a foreground start that never calls
            // startForeground() is itself a crash on Android 8+.
            runCatching { context.stopService(Intent(context, PhoneShareService::class.java)) }
        }

        /** Shown when Android will not let a background process start the foreground service. */
        private fun showResumeNotification(context: Context) {
            runCatching {
                val manager = context.getSystemService(NotificationManager::class.java) ?: return@runCatching
                if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(RESUME_CHANNEL) == null) {
                    manager.createNotificationChannel(
                        NotificationChannel(RESUME_CHANNEL, "Phone sharing", NotificationManager.IMPORTANCE_DEFAULT).apply {
                            description = "Shown when phone sharing is waiting for you to open Drivebay"
                        },
                    )
                }
                val open = PendingIntent.getActivity(
                    context,
                    1,
                    Intent(context, MainActivity::class.java).apply {
                        action = ACTION_RESUME
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                    },
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                val text = context.getString(R.string.phone_share_tap_resume)
                val notification = NotificationCompat.Builder(context, RESUME_CHANNEL)
                    .setSmallIcon(android.R.drawable.stat_notify_sync)
                    .setContentTitle(text)
                    .setContentText(text)
                    .setContentIntent(open)
                    .setAutoCancel(true)
                    .setOnlyAlertOnce(true)
                    .build()
                manager.notify(RESUME_NOTIFICATION_ID, notification)
            }
        }

        private fun cancelResumeNotification(context: Context) {
            runCatching {
                context.getSystemService(NotificationManager::class.java)?.cancel(RESUME_NOTIFICATION_ID)
            }
        }
    }
}
