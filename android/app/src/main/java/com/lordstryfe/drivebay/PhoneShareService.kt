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
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.util.concurrent.atomic.AtomicBoolean

/**
 * WebDAV share for the folders the user picked. Off until they turn it on.
 * The token hash and folder list live in [PhoneShareStore], so a killed or
 * restarted process can bind again without a new token. It rebinds when the
 * Tailscale or LAN address changes, and answers a LAN discovery probe so the
 * PC can find the new address.
 */
class PhoneShareService : Service() {
    private var server: PhoneDavServer? = null
    private var servedHash: String? = null
    private var servedFolders: String? = null
    private var attempt = 0
    private var stopping = false
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
            // startForegroundService requires a foreground call even when stopping.
            enterForeground(notification(emptyList()))
            stopping = true
            stopSharing()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        stopping = false
        val store = PhoneShareStore(this)
        if (!PhoneShareLifecycle.shouldResume(store.enabled(), store.tokenHash(), store.folders().size)) {
            enterForeground(notification(emptyList()))
            stopping = true
            stopSharing()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        enterForeground(notification(server?.boundHosts().orEmpty()))
        listenForNetworks()
        ensureDiscovery()
        refreshServer()
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Swiping the app away must not drop the share. stopWithTask is false;
        // keep the foreground service and let START_STICKY restart the process.
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        stopping = true
        stopSharing()
        super.onDestroy()
    }

    private fun refreshServer() {
        if (stopping) return
        ensureDiscovery()
        val store = PhoneShareStore(this)
        val hash = store.tokenHash()
        val folders = store.folders()
        if (!PhoneShareLifecycle.shouldResume(store.enabled(), hash, folders.size)) {
            stopping = true
            stopSharing()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return
        }
        val folderKey = folders.joinToString("|") { it.uri }
        val hosts = shareHosts()
        val bound = server?.boundHosts().orEmpty()
        val missing = hosts.filter { want -> bound.none { it.equals(want, ignoreCase = true) } }
        if (server != null && servedHash == hash && servedFolders == folderKey && bound.isNotEmpty() && missing.isEmpty()) {
            attempt = 0
            store.setListening(bound)
            schedule(PhoneShareLifecycle.HEALTHY_POLL_MS)
            return
        }
        if (server != null && servedHash == hash && servedFolders == folderKey && bound.isNotEmpty()) {
            // A new Tailscale or LAN address showed up. Add it without dropping the ones already open.
            server?.bindMore(missing)
            val now = server?.boundHosts().orEmpty()
            val stillMissing = hosts.filter { want -> now.none { it.equals(want, ignoreCase = true) } }
            store.setListening(now)
            broadcast(now)
            enterForeground(notification(now))
            if (stillMissing.isEmpty()) attempt = 0 else attempt++
            schedule(if (stillMissing.isEmpty()) PhoneShareLifecycle.HEALTHY_POLL_MS else PhoneShareLifecycle.retryDelayMs(attempt))
            return
        }
        server?.stop()
        server = null
        servedHash = null
        servedFolders = null
        if (hosts.isEmpty()) {
            store.setListening(emptyList())
            broadcast(emptyList())
            enterForeground(notification(emptyList()))
            attempt++
            schedule(PhoneShareLifecycle.retryDelayMs(attempt))
            return
        }
        val dav = PhoneDavServer(
            DocumentPhoneStore(this, folders),
            hash!!,
            PORT,
            hosts,
            PhoneShareLifecycle.peerId(hash),
        )
        if (!dav.start()) {
            store.setListening(emptyList())
            broadcast(emptyList())
            enterForeground(notification(emptyList()))
            attempt++
            schedule(PhoneShareLifecycle.retryDelayMs(attempt))
            return
        }
        server = dav
        servedHash = hash
        servedFolders = folderKey
        attempt = 0
        val listening = dav.boundHosts()
        store.setListening(listening)
        broadcast(listening)
        enterForeground(notification(listening))
        schedule(PhoneShareLifecycle.HEALTHY_POLL_MS)
    }

    private fun schedule(delayMs: Long) {
        mainHandler.removeCallbacks(refreshRunnable)
        if (!stopping) mainHandler.postDelayed(refreshRunnable, delayMs)
    }

    private fun stopSharing() {
        mainHandler.removeCallbacks(refreshRunnable)
        server?.stop()
        server = null
        servedHash = null
        servedFolders = null
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
        } catch (_: Exception) {
            // The poll still notices address changes.
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
            } catch (_: Exception) {
                socket.close()
                discoveryStarting.set(false)
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
        } catch (_: Exception) {
        }
    }

    private fun closeDiscovery() {
        discoveryStarting.set(false)
        val socket = discovery
        discovery = null
        if (socket != null) runCatching { socket.close() }
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
        val where = hosts.firstOrNull()?.let { "http://$it:$PORT/" } ?: getString(R.string.phone_share_reconnecting)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(getString(R.string.phone_share_on))
            .setContentText(where)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    private fun enterForeground(notification: Notification) {
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun broadcast(hosts: List<String>) {
        sendBroadcast(
            Intent(ACTION_STATE).apply {
                setPackage(packageName)
                putExtra(EXTRA_HOSTS, hosts.joinToString(","))
            },
        )
    }

    companion object {
        const val PORT = 8780
        const val ACTION_START = "com.lordstryfe.drivebay.PHONE_SHARE_START"
        const val ACTION_STOP = "com.lordstryfe.drivebay.PHONE_SHARE_STOP"
        const val ACTION_STATE = "com.lordstryfe.drivebay.PHONE_SHARE_STATE"
        const val EXTRA_HOSTS = "hosts"
        private const val CHANNEL = "phone_share"
        private const val NOTIFICATION_ID = 44

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

        fun resumeIfEnabled(context: Context) {
            val store = PhoneShareStore(context)
            if (!PhoneShareLifecycle.shouldResume(store.enabled(), store.tokenHash(), store.folders().size)) return
            try {
                start(context)
            } catch (_: Exception) {
                // A background start can be refused. The next time the app opens, it tries again.
            }
        }

        fun start(context: Context) {
            val intent = Intent(context, PhoneShareService::class.java).apply { action = ACTION_START }
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, PhoneShareService::class.java).apply { action = ACTION_STOP }
            try {
                ContextCompat.startForegroundService(context, intent)
            } catch (_: Exception) {
                context.stopService(Intent(context, PhoneShareService::class.java))
            }
        }
    }
}
