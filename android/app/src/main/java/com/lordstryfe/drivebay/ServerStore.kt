package com.lordstryfe.drivebay

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Saved server list. Passwords live in [CredentialVault], not in this file. */
class ServerStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val vault = CredentialVault(context)

    fun all(): List<SavedServer> {
        val raw = prefs.getString(KEY_LIST, null) ?: return emptyList()
        return try {
            val array = JSONArray(raw)
            buildList {
                for (i in 0 until array.length()) add(fromJson(array.getJSONObject(i)))
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun find(url: String): SavedServer? {
        val key = ServerProfiles.keyOf(url)
        return all().firstOrNull { ServerProfiles.keyOf(it.url) == key }
    }

    fun touch(url: String, name: String?): SavedServer {
        val existing = find(url)
        if (existing != null) {
            val next = if (!name.isNullOrBlank() && name != existing.name) existing.copy(name = name.take(40)) else existing
            if (next != existing) update(next)
            return find(url) ?: next
        }
        val created = SavedServer(
            id = ServerProfiles.idFor(url),
            name = name?.trim()?.take(40)?.ifBlank { null } ?: ServerProfiles.defaultName(url),
            url = ServerAddress.normalize(url),
            username = null,
            rememberLogin = true,
        )
        write(all() + created)
        return created
    }

    fun update(server: SavedServer) {
        val next = all().map { if (it.id == server.id) server else it }
        write(if (next.any { it.id == server.id }) next else next + server)
    }

    fun delete(id: String) {
        vault.forget(id)
        write(all().filterNot { it.id == id })
    }

    fun saveLogin(server: SavedServer, username: String, password: String) {
        vault.save(server.id, password)
        update(server.copy(username = username, rememberLogin = true))
    }

    fun forgetLogin(server: SavedServer) {
        vault.forget(server.id)
        update(server.copy(username = null, rememberLogin = false))
    }

    private fun write(servers: List<SavedServer>) {
        val array = JSONArray()
        servers.forEach { array.put(toJson(it)) }
        prefs.edit().putString(KEY_LIST, array.toString()).apply()
    }

    private fun toJson(server: SavedServer) = JSONObject()
        .put("id", server.id)
        .put("name", server.name)
        .put("url", server.url)
        .put("username", server.username ?: "")
        .put("rememberLogin", server.rememberLogin)

    private fun fromJson(obj: JSONObject) = SavedServer(
        id = obj.getString("id"),
        name = obj.optString("name").ifBlank { "Drivebay" },
        url = obj.getString("url"),
        username = obj.optString("username").ifBlank { null },
        rememberLogin = obj.optBoolean("rememberLogin", true),
    )

    companion object {
        private const val PREFS = "drivebay_servers"
        private const val KEY_LIST = "servers"
    }
}
