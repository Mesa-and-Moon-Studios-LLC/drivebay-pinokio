package com.lordstryfe.drivebay

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Base64
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.google.android.material.button.MaterialButton
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.NetworkInterface
import java.net.URL
import java.security.SecureRandom
import java.time.Instant
import java.util.UUID
import kotlin.concurrent.thread

/**
 * Mesa and Moon sign-in and My machines on the phone.
 * Pair tokens stay in the local vault. The cloud gets connection info only.
 */
object MesaPanel {
    private const val REDIRECT = "drivebay://mesa"
    private const val RISK =
        "Direct internet opens this port on the public network. Anyone who can reach that port can try to connect. Your files stay on this machine and do not pass through Mesa and Moon servers. This is less safe than Tailscale. Turn it on only if you forwarded the port yourself."

    fun bind(activity: Activity) {
        val status = activity.findViewById<TextView>(R.id.mesaStatus)
        val google = activity.findViewById<MaterialButton>(R.id.mesaGoogle)
        val apple = activity.findViewById<MaterialButton>(R.id.mesaApple)
        val machines = activity.findViewById<MaterialButton>(R.id.mesaMachines)
        val hidden = activity.findViewById<CheckBox>(R.id.mesaHidden)
        val share = PhoneShareStore(activity)
        hidden.isChecked = share.hidden()
        hidden.setOnCheckedChangeListener { _, checked ->
            share.setHidden(checked)
            register(activity)
        }
        refresh(activity, status)
        google.setOnClickListener { start(activity, "google") }
        apple.setOnClickListener { start(activity, "apple") }
        machines.setOnClickListener { showMachines(activity) }
    }

    fun consume(activity: Activity, intent: Intent?) {
        val data = intent?.data?.toString() ?: return
        val parsed = MesaCloud.readFragment(data) ?: return
        val expected = activity.getSharedPreferences("drivebay_mesa", Activity.MODE_PRIVATE).getString("nonce", "")
        if (expected.isNullOrBlank() || parsed.second != expected) {
            toast(activity, "That Mesa and Moon sign-in did not match this phone.")
            return
        }
        val config = loadConfig(activity) ?: return
        val provider = if (parsed.first == "apple") "apple.com" else "google.com"
        thread(name = "mesa-signin") {
            val session = exchange(config, provider, parsed.third)
            activity.runOnUiThread {
                if (session == null) {
                    toast(activity, "Mesa and Moon did not accept that sign-in.")
                } else {
                    saveSession(activity, session)
                    register(activity)
                    refresh(activity, activity.findViewById(R.id.mesaStatus))
                    toast(activity, "Signed in to Mesa and Moon")
                }
            }
        }
    }

    private fun start(activity: Activity, provider: String) {
        val config = loadConfig(activity)
        if (config == null || !config.ready) {
            toast(activity, "Add mesa-firebase.json on this phone. Drivebay keeps working without it.")
            return
        }
        val clientId = if (provider == "google") config.googleClientId else config.appleClientId
        if (clientId.isBlank()) {
            toast(activity, if (provider == "google") "Google sign-in is not configured." else "Apple sign-in is not configured.")
            return
        }
        val nonce = UUID.randomUUID().toString()
        activity.getSharedPreferences("drivebay_mesa", Activity.MODE_PRIVATE).edit().putString("nonce", nonce).apply()
        val url = if (provider == "google") {
            MesaCloud.googleAuthorizeUrl(clientId, REDIRECT, nonce)
        } else {
            MesaCloud.appleAuthorizeUrl(clientId, REDIRECT, nonce)
        }
        activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    }

    private fun showMachines(activity: Activity) {
        val config = loadConfig(activity)
        val session = loadSession(activity)
        if (config == null || session == null) {
            toast(activity, "Sign in to Mesa and Moon to see your machines.")
            return
        }
        thread(name = "mesa-machines") {
            val list = fetchMachines(config, session.first, machineId(activity))
            activity.runOnUiThread {
                if (list == null) {
                    toast(activity, "The Mesa and Moon cloud did not return machines.")
                    return@runOnUiThread
                }
                val body = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
                if (list.length() == 0) {
                    body.addView(TextView(activity).apply { text = "No machines on this login yet." })
                }
                for (i in 0 until list.length()) {
                    val row = list.getJSONObject(i)
                    val title = row.optString("displayName") + " · " + row.optString("type") +
                        if (MesaCloud.isOnline(row.optString("lastSeen"), System.currentTimeMillis())) " · online" else " · offline"
                    body.addView(TextView(activity).apply {
                        text = title
                        setPadding(0, 12, 0, 0)
                    })
                    if (row.optString("machineId") == machineId(activity)) continue
                    body.addView(MaterialButton(activity).apply {
                        text = activity.getString(R.string.mesa_connect)
                        isAllCaps = false
                        setOnClickListener { connect(activity, row) }
                    })
                }
                android.app.AlertDialog.Builder(activity)
                    .setTitle(R.string.mesa_machines)
                    .setView(body)
                    .setNegativeButton(android.R.string.cancel, null)
                    .show()
            }
        }
    }

    private fun connect(activity: Activity, machine: JSONObject) {
        if (MesaCloud.usesPublicInternet(machine)) {
            android.app.AlertDialog.Builder(activity)
                .setMessage(RISK)
                .setPositiveButton(R.string.mesa_connect_public) { _, _ -> askCode(activity, machine) }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
            return
        }
        askCode(activity, machine)
    }

    private fun askCode(activity: Activity, machine: JSONObject) {
        val input = android.widget.EditText(activity).apply { hint = activity.getString(R.string.mesa_code_hint) }
        android.app.AlertDialog.Builder(activity)
            .setTitle(machine.optString("displayName"))
            .setView(input)
            .setPositiveButton(R.string.mesa_connect) { _, _ ->
                val code = input.text?.toString()?.trim().orEmpty()
                openMachine(activity, machine, code)
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun openMachine(activity: Activity, machine: JSONObject, code: String) {
        val url = MesaCloud.connectionUrl(machine)
        if (url.isEmpty()) {
            toast(activity, "That machine has no Tailscale or LAN address.")
            return
        }
        thread(name = "mesa-connect") {
            val token = if (machine.optString("type") == "phone") code else redeem(url, code, activity)
            if (token.isNullOrBlank()) {
                activity.runOnUiThread { toast(activity, "That machine refused the code.") }
                return@thread
            }
            CredentialVault(activity).save("link-" + machine.optString("machineId"), token)
            val names = propfind(url, token)
            activity.runOnUiThread {
                val message = if (names.isEmpty()) "Connected. No folders are shared." else names.joinToString("\n")
                android.app.AlertDialog.Builder(activity)
                    .setTitle(machine.optString("displayName"))
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok, null)
                    .show()
            }
        }
    }

    private fun redeem(url: String, code: String, activity: Activity): String? {
        val origin = url.substringBefore("/dav").trimEnd('/')
        val body = JSONObject()
            .put("code", code)
            .put("machineId", machineId(activity))
            .put("displayName", android.os.Build.MODEL ?: "Phone")
            .toString()
        val text = post("$origin/api/link/redeem", body, null) ?: return null
        return runCatching { JSONObject(text).optString("token") }.getOrNull()?.takeIf { it.isNotBlank() }
    }

    private fun propfind(url: String, token: String): List<String> {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "PROPFIND"
            setRequestProperty("Depth", "1")
            setRequestProperty("Authorization", "Basic " + Base64.encodeToString("drivebay:$token".toByteArray(), Base64.NO_WRAP))
            connectTimeout = 8000
            readTimeout = 8000
        }
        return try {
            if (connection.responseCode != 207) emptyList()
            else MesaCloud.shareNames(connection.inputStream.bufferedReader().readText())
        } catch (_: Exception) {
            emptyList()
        } finally {
            connection.disconnect()
        }
    }

    fun register(activity: Activity) {
        val config = loadConfig(activity) ?: return
        val session = loadSession(activity) ?: return
        val share = PhoneShareStore(activity)
        val (tailscale, lan) = MesaCloud.classify(localAddresses())
        val body = MesaCloud.registration(
            machineId(activity),
            android.os.Build.MODEL ?: "Phone",
            tailscale,
            lan,
            PhoneShareService.PORT,
            publicKey(activity),
            Instant.now().toString(),
            share.hidden(),
            false,
            "",
        )
        thread(name = "mesa-register") {
            post(config.cloudApi + "/machines.php", body.toString(), session.first)
        }
    }

    private fun refresh(activity: Activity, status: TextView) {
        val session = loadSession(activity)
        status.text = if (session == null) {
            activity.getString(R.string.mesa_signed_out)
        } else {
            activity.getString(R.string.mesa_signed_in, session.second)
        }
    }

    private fun loadConfig(activity: Activity): MesaCloud.Config? {
        val file = File(activity.filesDir, "mesa-firebase.json")
        val text = when {
            file.isFile -> file.readText()
            else -> runCatching { activity.assets.open("mesa-firebase.json").bufferedReader().readText() }.getOrNull()
        } ?: return null
        val parsed = MesaCloud.parseConfig(text) ?: return null
        return parsed.takeIf { it.ready }
    }

    private fun saveSession(activity: Activity, session: Triple<String, String, String>) {
        CredentialVault(activity).save("mesa-refresh", session.third)
        activity.getSharedPreferences("drivebay_mesa", Activity.MODE_PRIVATE).edit()
            .putString("idToken", session.first)
            .putString("email", session.second)
            .apply()
    }

    private fun loadSession(activity: Activity): Pair<String, String>? {
        val prefs = activity.getSharedPreferences("drivebay_mesa", Activity.MODE_PRIVATE)
        val token = prefs.getString("idToken", "") ?: ""
        if (token.isBlank()) return null
        return token to (prefs.getString("email", "") ?: "")
    }

    private fun machineId(activity: Activity): String {
        val prefs = activity.getSharedPreferences("drivebay_mesa", Activity.MODE_PRIVATE)
        val existing = prefs.getString("machineId", "") ?: ""
        if (existing.isNotBlank()) return existing
        val created = "phone-" + UUID.randomUUID().toString().replace("-", "").take(16)
        prefs.edit().putString("machineId", created).apply()
        return created
    }

    private fun publicKey(activity: Activity): String {
        val prefs = activity.getSharedPreferences("drivebay_mesa", Activity.MODE_PRIVATE)
        val existing = prefs.getString("publicKey", "") ?: ""
        if (existing.isNotBlank()) return existing
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val created = Base64.encodeToString(bytes, Base64.NO_WRAP)
        prefs.edit().putString("publicKey", created).apply()
        return created
    }

    private fun localAddresses(): List<String> {
        val out = mutableListOf<String>()
        val nets = NetworkInterface.getNetworkInterfaces() ?: return out
        for (net in nets) {
            for (addr in net.inetAddresses) {
                if (addr.isLoopbackAddress) continue
                val host = addr.hostAddress?.substringBefore('%') ?: continue
                out.add(host)
            }
        }
        return out
    }

    private fun exchange(config: MesaCloud.Config, provider: String, idToken: String): Triple<String, String, String>? {
        val body = MesaCloud.idpBody(provider, idToken, REDIRECT)
        val text = post(
            "https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=" + config.apiKey,
            body,
            null,
        ) ?: return null
        val json = runCatching { JSONObject(text) }.getOrNull() ?: return null
        val next = json.optString("idToken")
        val refresh = json.optString("refreshToken")
        if (next.isBlank() || refresh.isBlank()) return null
        return Triple(next, json.optString("email"), refresh)
    }

    private fun fetchMachines(config: MesaCloud.Config, idToken: String, self: String): JSONArray? {
        val text = get(config.cloudApi + "/machines.php?self=" + self, idToken) ?: return null
        return runCatching { JSONObject(text).optJSONArray("machines") ?: JSONArray() }.getOrNull()
    }

    private fun post(url: String, body: String, bearer: String?): String? {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            if (!bearer.isNullOrBlank()) setRequestProperty("Authorization", "Bearer $bearer")
            connectTimeout = 8000
            readTimeout = 8000
        }
        return try {
            connection.outputStream.use { it.write(body.toByteArray()) }
            if (connection.responseCode !in 200..299) null else connection.inputStream.bufferedReader().readText()
        } catch (_: Exception) {
            null
        } finally {
            connection.disconnect()
        }
    }

    private fun get(url: String, bearer: String): String? {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            setRequestProperty("Authorization", "Bearer $bearer")
            connectTimeout = 8000
            readTimeout = 8000
        }
        return try {
            if (connection.responseCode !in 200..299) null else connection.inputStream.bufferedReader().readText()
        } catch (_: Exception) {
            null
        } finally {
            connection.disconnect()
        }
    }

    private fun toast(activity: Activity, message: String) {
        Toast.makeText(activity, message, Toast.LENGTH_LONG).show()
    }
}
