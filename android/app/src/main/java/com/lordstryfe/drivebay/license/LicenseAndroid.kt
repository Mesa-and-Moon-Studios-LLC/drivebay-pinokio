package com.lordstryfe.drivebay.license

import android.content.Context
import com.lordstryfe.drivebay.BuildConfig
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Android glue for [LicenseManager]: SharedPreferences storage and a plain HttpURLConnection client. */
class PrefsLicenseStorage(context: Context) : LicenseStorage {
    private val prefs = context.getSharedPreferences("drivebay_license", Context.MODE_PRIVATE)
    override fun load(): LicenseRecord? {
        val key = prefs.getString("key", null) ?: return null
        return LicenseRecord(key, prefs.getString("receipt", "").orEmpty(), prefs.getLong("lastCheckAt", 0), prefs.getString("lastError", "").orEmpty())
    }
    override fun save(record: LicenseRecord) {
        prefs.edit().putString("key", record.key).putString("receipt", record.receipt).putLong("lastCheckAt", record.lastCheckAt).putString("lastError", record.lastError).apply()
    }
    override fun clear() {
        prefs.edit().clear().apply()
    }
}

class UrlLicenseHttp(private val api: String = LicenseConfig.API) : LicenseHttp {
    override fun post(action: String, body: JSONObject): HttpReply {
        val connection = (URL("$api?action=$action").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/json")
            // The host firewall refuses browser-looking agents on POST, so say who we are.
            setRequestProperty("User-Agent", "Drivebay/${BuildConfig.VERSION_NAME} (license)")
            connectTimeout = 10000
            readTimeout = 10000
        }
        return try {
            connection.outputStream.use { it.write(body.toString().toByteArray()) }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.readText().orEmpty()
            HttpReply(code, runCatching { JSONObject(text) }.getOrNull())
        } catch (_: Exception) {
            HttpReply(0, null, network = true)
        } finally {
            connection.disconnect()
        }
    }
}

object Editions {
    fun manager(context: Context, machineId: () -> String): LicenseManager = LicenseManager(
        storage = PrefsLicenseStorage(context.applicationContext),
        http = UrlLicenseHttp(),
        machineId = machineId,
        deviceName = { android.os.Build.MODEL ?: "Phone" },
        appVersion = BuildConfig.VERSION_NAME,
        buildTs = BuildConfig.BUILD_TS_SECONDS,
    )
}
