package com.lordstryfe.drivebay

import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/** Posts a picked phone file to the Drivebay PC using the WebView session cookie. */
object PhoneUpload {
    fun post(target: String, cookie: String, body: InputStream, length: Long, userAgent: String): Int {
        val conn = URL(target).openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.connectTimeout = 20_000
            conn.readTimeout = 120_000
            conn.instanceFollowRedirects = false
            if (cookie.isNotBlank()) conn.setRequestProperty("Cookie", cookie)
            if (userAgent.isNotBlank()) conn.setRequestProperty("User-Agent", userAgent)
            conn.setRequestProperty("Content-Type", "application/octet-stream")
            if (length >= 0) conn.setFixedLengthStreamingMode(length)
            conn.outputStream.use { out -> body.copyTo(out) }
            conn.responseCode
        } finally {
            conn.disconnect()
        }
    }
}
