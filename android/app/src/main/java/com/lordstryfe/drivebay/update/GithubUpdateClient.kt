package com.lordstryfe.drivebay.update

import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Reads the latest GitHub release and downloads an APK.
 * Only https GitHub hosts are followed, including redirects.
 */
internal object GithubUpdateClient {
    private const val USER_AGENT = "Drivebay"
    private const val MAX_REDIRECTS = 5

    fun fetchReleaseJson(): String? =
        getText(UpdateVersions.RELEASES_LATEST, UpdateVersions.MAX_RELEASE_BYTES, "application/vnd.github+json")

    fun fetchText(url: String, maxBytes: Int): String? =
        getText(url, maxBytes, "application/json, */*;q=0.8")

    fun download(url: String, dest: File): Boolean {
        val conn = connect(url, "application/vnd.android.package-archive, application/octet-stream;q=0.9") ?: return false
        val tmp = File(dest.parentFile, dest.name + ".part")
        var published = false
        return try {
            dest.parentFile?.mkdirs()
            var total = 0L
            var zip = false
            conn.inputStream.use { input ->
                tmp.outputStream().use { output ->
                    val buf = ByteArray(8192)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        if (!zip) {
                            if (n < 2 || buf[0] != 0x50.toByte() || buf[1] != 0x4B.toByte()) {
                                throw IllegalStateException("not an apk")
                            }
                            zip = true
                        }
                        total += n
                        if (total > UpdateVersions.MAX_APK_BYTES) throw IllegalStateException("apk too large")
                        output.write(buf, 0, n)
                    }
                }
            }
            if (!zip || total < 4) {
                false
            } else if (dest.exists() && !dest.delete()) {
                false
            } else {
                published = tmp.renameTo(dest)
                published
            }
        } catch (_: Exception) {
            false
        } finally {
            conn.disconnect()
            if (!published && tmp.exists()) tmp.delete()
        }
    }

    private fun getText(url: String, maxBytes: Int, accept: String): String? {
        val conn = connect(url, accept) ?: return null
        return try {
            val bytes = conn.inputStream.use { input ->
                val buf = java.io.ByteArrayOutputStream()
                val chunk = ByteArray(8192)
                while (true) {
                    val n = input.read(chunk)
                    if (n < 0) break
                    if (buf.size() + n > maxBytes) return null
                    buf.write(chunk, 0, n)
                }
                buf.toByteArray()
            }
            String(bytes, Charsets.UTF_8)
        } catch (_: Exception) {
            null
        } finally {
            conn.disconnect()
        }
    }

    private fun connect(start: String, accept: String): HttpURLConnection? {
        var current = start
        repeat(MAX_REDIRECTS) {
            if (!UpdateVersions.isAllowedDownloadUrl(current)) return null
            val conn = (URL(current).openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = 15_000
                readTimeout = 60_000
                useCaches = false
                setRequestProperty("User-Agent", USER_AGENT)
                setRequestProperty("Accept", accept)
                setRequestProperty("Cache-Control", "no-cache")
            }
            try {
                val code = conn.responseCode
                if (code in 300..399) {
                    val next = conn.getHeaderField("Location")
                    conn.disconnect()
                    if (next.isNullOrBlank()) return null
                    current = URL(URL(current), next).toString()
                    return@repeat
                }
                if (code !in 200..299) {
                    conn.disconnect()
                    return null
                }
                return conn
            } catch (_: Exception) {
                conn.disconnect()
                return null
            }
        }
        return null
    }
}
