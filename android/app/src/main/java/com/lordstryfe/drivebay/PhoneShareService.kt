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
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.net.NetworkInterface

/**
 * Optional WebDAV server. Off until the user turns it on.
 * It binds only to Tailscale and private LAN addresses.
 */
class PhoneShareService : Service() {
    private var server: PhoneDavServer? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSharing()
            stopSelf()
            return START_NOT_STICKY
        }
        val store = PhoneShareStore(this)
        val hash = store.tokenHash()
        val folders = store.folders()
        if (!store.enabled() || hash == null || folders.isEmpty()) {
            stopSharing()
            stopSelf()
            return START_NOT_STICKY
        }
        val hosts = shareHosts()
        enterForeground(notification(hosts))
        if (hosts.isEmpty()) {
            broadcast(emptyList())
            return START_STICKY
        }
        stopSharing()
        val dav = PhoneDavServer(DocumentPhoneStore(this, folders), hash, PORT, hosts)
        dav.start()
        server = dav
        broadcast(hosts)
        return START_STICKY
    }

    override fun onDestroy() {
        stopSharing()
        super.onDestroy()
    }

    private fun stopSharing() {
        server?.stop()
        server = null
        broadcast(emptyList())
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
