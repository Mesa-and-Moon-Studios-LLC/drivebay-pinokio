package com.lordstryfe.drivebay

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class DownloadRepository(context: Context) {
    private val root = File(context.filesDir, "downloads").apply { mkdirs() }
    private val store = File(root, "jobs.json")
    private val partialDir = File(root, "partial").apply { mkdirs() }

    @Synchronized
    fun load(): List<DownloadJob> {
        if (!store.exists()) return emptyList()
        return try {
            val array = JSONArray(store.readText())
            buildList {
                for (i in 0 until array.length()) {
                    add(fromJson(array.getJSONObject(i)))
                }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    @Synchronized
    fun upsert(job: DownloadJob) {
        val next = load().filterNot { it.id == job.id } + job
        write(next)
    }

    @Synchronized
    fun remove(id: String) {
        write(load().filterNot { it.id == id })
        partialFile(id).delete()
    }

    fun partialFile(id: String): File = File(partialDir, "$id.part")

    fun hasRunnable(onWifi: Boolean): Boolean = nextRunnable(onWifi) != null

    fun hasResumeWork(): Boolean = load().any {
        it.state == DownloadJob.STATE_QUEUED || it.state == DownloadJob.STATE_RUNNING
    }

    /**
     * Prefer a job that can transfer now. A Wi-Fi-only job is still returned
     * when every waiting job needs Wi-Fi, so the service can show "Waiting for Wi-Fi".
     */
    @Synchronized
    fun nextRunnable(onWifi: Boolean): DownloadJob? {
        val waiting = load().filter { it.runnable() }
        if (waiting.isEmpty()) return null
        val ready = waiting.filter { !it.wifiOnly || onWifi }
        val pool = ready.ifEmpty { waiting }
        return pool.minByOrNull { it.createdAt }
    }

    private fun write(jobs: List<DownloadJob>) {
        val array = JSONArray()
        jobs.forEach { array.put(toJson(it)) }
        store.parentFile?.mkdirs()
        val tmp = File(store.parentFile, "jobs.json.tmp")
        tmp.writeText(array.toString())
        if (!tmp.renameTo(store)) {
            store.writeText(array.toString())
            tmp.delete()
        }
    }

    private fun toJson(job: DownloadJob): JSONObject = JSONObject()
        .put("id", job.id)
        .put("url", job.url)
        .put("fileName", job.fileName)
        .put("cookie", job.cookie)
        .put("userAgent", job.userAgent)
        .put("totalBytes", job.totalBytes)
        .put("downloadedBytes", job.downloadedBytes)
        .put("etag", job.etag)
        .put("mime", job.mime)
        .put("wifiOnly", job.wifiOnly)
        .put("state", job.state)
        .put("error", job.error)
        .put("createdAt", job.createdAt)

    private fun fromJson(obj: JSONObject) = DownloadJob(
        id = obj.getString("id"),
        url = obj.getString("url"),
        fileName = obj.getString("fileName"),
        cookie = obj.optString("cookie"),
        userAgent = obj.optString("userAgent"),
        totalBytes = obj.optLong("totalBytes", -1L),
        downloadedBytes = obj.optLong("downloadedBytes", 0L),
        etag = obj.optString("etag").ifBlank { null },
        mime = obj.optString("mime").ifBlank { null },
        wifiOnly = obj.optBoolean("wifiOnly", false),
        state = obj.optString("state", DownloadJob.STATE_QUEUED),
        error = obj.optString("error").ifBlank { null },
        createdAt = obj.optLong("createdAt", 0L),
    )
}
