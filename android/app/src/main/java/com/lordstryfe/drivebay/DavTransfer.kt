package com.lordstryfe.drivebay

import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * GET and PUT with progress, for the linked-machine browser. HttpURLConnection can do both.
 * Every call catches its own errors and returns a [Result]. Status 0 means the machine could not
 * be reached or the connection broke. Status -1 means the user cancelled.
 */
object DavTransfer {
    data class Result(val status: Int, val message: String = "") {
        val ok: Boolean get() = status in 200..299
        val cancelled: Boolean get() = status == CANCELLED
    }

    const val CANCELLED = -1

    fun download(
        url: String,
        basicAuth: String,
        dest: File,
        onProgress: (done: Long, total: Long) -> Unit,
        cancelled: () -> Boolean,
    ): Result {
        var connection: HttpURLConnection? = null
        return try {
            connection = open(url, basicAuth, "GET")
            val status = connection.responseCode
            if (status != 200) return Result(status, errorBody(connection))
            val total = connection.contentLengthLong
            var done = 0L
            connection.inputStream.use { input ->
                dest.outputStream().use { out ->
                    val buffer = ByteArray(64 * 1024)
                    var lastReport = 0L
                    while (true) {
                        if (cancelled()) {
                            dest.delete()
                            return Result(CANCELLED)
                        }
                        val n = input.read(buffer)
                        if (n < 0) break
                        out.write(buffer, 0, n)
                        done += n
                        val now = System.currentTimeMillis()
                        if (now - lastReport > 120) {
                            lastReport = now
                            onProgress(done, total)
                        }
                    }
                }
            }
            if (total >= 0 && done != total) {
                dest.delete()
                return Result(0, "The download stopped early.")
            }
            onProgress(done, total)
            Result(200)
        } catch (err: Exception) {
            dest.delete()
            Result(0, err.message.orEmpty())
        } finally {
            connection?.disconnect()
        }
    }

    fun upload(
        url: String,
        basicAuth: String,
        input: InputStream,
        length: Long,
        onProgress: (done: Long, total: Long) -> Unit,
        cancelled: () -> Boolean,
    ): Result {
        var connection: HttpURLConnection? = null
        return try {
            connection = open(url, basicAuth, "PUT")
            connection.doOutput = true
            if (length >= 0) connection.setFixedLengthStreamingMode(length) else connection.setChunkedStreamingMode(64 * 1024)
            var done = 0L
            connection.outputStream.use { out ->
                val buffer = ByteArray(64 * 1024)
                var lastReport = 0L
                while (true) {
                    if (cancelled()) {
                        connection.disconnect()
                        return Result(CANCELLED)
                    }
                    val n = input.read(buffer)
                    if (n < 0) break
                    out.write(buffer, 0, n)
                    done += n
                    val now = System.currentTimeMillis()
                    if (now - lastReport > 120) {
                        lastReport = now
                        onProgress(done, length)
                    }
                }
            }
            val status = connection.responseCode
            onProgress(done, length)
            if (status in 200..299) Result(status) else Result(status, errorBody(connection))
        } catch (err: Exception) {
            Result(0, err.message.orEmpty())
        } finally {
            connection?.disconnect()
        }
    }

    private fun open(url: String, basicAuth: String, method: String): HttpURLConnection {
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = 8000
        connection.readTimeout = 30000
        connection.instanceFollowRedirects = false
        connection.setRequestProperty("Authorization", "Basic $basicAuth")
        return connection
    }

    private fun errorBody(connection: HttpURLConnection): String =
        runCatching { connection.errorStream?.use { String(it.readBytes().take(512).toByteArray(), Charsets.UTF_8) }.orEmpty() }
            .getOrDefault("")
}
