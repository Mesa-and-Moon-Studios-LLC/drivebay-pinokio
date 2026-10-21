package com.lordstryfe.drivebay

import android.content.Context
import android.os.Build
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Keeps the last crash and the last handled error on the phone so we can debug without adb.
 * Settings > Phone as a drive > Error log shows it and can share it as plain text.
 * Nothing leaves the phone unless the user taps Share. Tokens never go into this file.
 */
object CrashLog {
    private const val DIR = "diagnostics"
    private const val FILE = "last-error.txt"
    private const val MAX_CHARS = 48 * 1024
    private const val PREFS = "drivebay_crash_log"
    private const val KEY_SEEN = "seen_stamp"

    @Volatile private var installed = false

    /** Call first thing in Application.onCreate. Records, then hands off to the system handler. */
    fun install(context: Context) {
        if (installed) return
        installed = true
        val app = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching { write(app, "Crash on thread ${thread.name}", error) }
            if (previous != null) previous.uncaughtException(thread, error) else {
                android.os.Process.killProcess(android.os.Process.myPid())
                System.exit(10)
            }
        }
    }

    /** A failure we caught and showed to the user. */
    fun record(context: Context, where: String, error: Throwable) {
        runCatching { write(context.applicationContext, "Handled error: $where", error) }
    }

    fun read(context: Context): String? {
        val file = file(context)
        return if (file.isFile) runCatching { file.readText() }.getOrNull()?.takeIf { it.isNotBlank() } else null
    }

    fun clear(context: Context) {
        runCatching { file(context).delete() }
    }

    /** True once per new log, so the app can point the user to it after a crash. */
    fun hasUnseen(context: Context): Boolean {
        val file = file(context)
        if (!file.isFile) return false
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val stamp = file.lastModified()
        if (prefs.getLong(KEY_SEEN, 0L) == stamp) return false
        prefs.edit().putLong(KEY_SEEN, stamp).apply()
        return true
    }

    private fun file(context: Context): File = File(File(context.filesDir, DIR), FILE)

    private fun write(context: Context, title: String, error: Throwable) {
        val versionName = runCatching {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName
        }.getOrNull() ?: "?"
        val versionCode = runCatching {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
        }.getOrDefault(0L)
        val text = format(
            title = title,
            error = error,
            nowMillis = System.currentTimeMillis(),
            app = "Drivebay $versionName ($versionCode)",
            device = "${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT})",
        )
        val target = file(context)
        target.parentFile?.mkdirs()
        val tmp = File(target.parentFile, "$FILE.tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(target)) {
            target.writeText(text)
            tmp.delete()
        }
    }

    /** Pure so it can be unit tested on the JVM. */
    fun format(title: String, error: Throwable, nowMillis: Long, app: String, device: String): String {
        val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss 'UTC'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(Date(nowMillis))
        val trace = StringWriter().also { error.printStackTrace(PrintWriter(it)) }.toString()
        val body = buildString {
            append(title).append('\n')
            append("When: ").append(stamp).append('\n')
            append("App: ").append(app).append('\n')
            append("Device: ").append(device).append('\n')
            append('\n')
            append(redact(trace))
        }
        return if (body.length <= MAX_CHARS) body else body.substring(0, MAX_CHARS) + "\n…(cut)"
    }

    /** Drivebay tokens are db_ + 64 hex. Never keep one in a log the user may share. */
    fun redact(text: String): String = text.replace(Regex("db_[0-9a-fA-F]{64}"), "db_[redacted]")
}
