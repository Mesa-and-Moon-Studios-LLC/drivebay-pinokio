package com.lordstryfe.drivebay

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Base64
import android.text.InputType
import android.view.View
import android.widget.CheckBox
import android.widget.EditText
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
    private const val RISK =
        "Direct internet opens this port on the public network. Anyone who can reach that port can try to connect. Your files stay on this machine and do not pass through Mesa and Moon servers. This is less safe than Tailscale. Turn it on only if you forwarded the port yourself."

    fun bind(activity: Activity) {
        val status = activity.findViewById<TextView>(R.id.mesaStatus)
        val google = activity.findViewById<MaterialButton>(R.id.mesaGoogle)
        val apple = activity.findViewById<MaterialButton>(R.id.mesaApple)
        val email = activity.findViewById<MaterialButton>(R.id.mesaEmail)
        val signOut = activity.findViewById<MaterialButton>(R.id.mesaSignOut)
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
        email.setOnClickListener { emailDialog(activity) }
        signOut.setOnClickListener {
            clearSession(activity)
            refresh(activity, status)
            toast(activity, "Signed out of Mesa and Moon")
        }
        machines.setOnClickListener { showMachines(activity) }
    }

    fun consume(activity: Activity, intent: Intent?) {
        val data = intent?.data?.toString() ?: return
        val session = MesaCloud.readBridgeSession(data) ?: return
        val prefs = activity.getSharedPreferences("drivebay_mesa", Activity.MODE_PRIVATE)
        val expected = prefs.getString("nonce", "")
        if (expected.isNullOrBlank() || session.state != expected) {
            toast(activity, "That Mesa and Moon sign-in did not match this phone.")
            return
        }
        prefs.edit().remove("nonce").apply()
        // The sign-in page already ran the Firebase sign-in. Keep the Firebase session it handed back.
        saveSession(activity, Triple(session.idToken, session.email, session.refreshToken))
        register(activity)
        refresh(activity, activity.findViewById(R.id.mesaStatus))
        toast(activity, "Signed in to Mesa and Moon")
    }

    private fun start(activity: Activity, provider: String) {
        val config = loadConfig(activity)
        if (config == null || !config.ready) {
            toast(activity, "Add mesa-firebase.json on this phone. Drivebay keeps working without it.")
            return
        }
        val clientId = if (provider == "google") config.googleClientId else config.appleClientId
        val bridge = MesaCloud.signinBridgeUrl(config)
        if (clientId.isBlank() || bridge.isBlank()) {
            toast(activity, if (provider == "google") "Google sign-in is not configured." else "Apple sign-in is not configured.")
            return
        }
        val nonce = UUID.randomUUID().toString()
        activity.getSharedPreferences("drivebay_mesa", Activity.MODE_PRIVATE).edit().putString("nonce", nonce).apply()
        val url = MesaCloud.bridgeStartUrl(bridge, provider, nonce)
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
            // Refresh this phone's own record first so the other machines see it as online.
            registerBlocking(activity)
            val directory = fetchDirectory(config, session.first, machineId(activity))
            if (directory == null) {
                activity.runOnUiThread { toast(activity, "The Mesa and Moon cloud did not return machines.") }
                return@thread
            }
            var dek = loadDek(activity)
            if (directory.locked && dek == null) {
                // The list is encrypted with the join password. Ask for it, then reopen.
                activity.runOnUiThread {
                    askJoinPassword(activity, directory.wraps) { showMachines(activity) }
                }
                return@thread
            }
            val list = if (directory.locked && dek != null) openLocked(dek, directory.machines) else directory.machines
            activity.runOnUiThread {
                val body = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
                if (list.length() == 0) {
                    body.addView(TextView(activity).apply { text = "No machines on this login yet." })
                }
                if (!directory.locked) {
                    body.addView(TextView(activity).apply {
                        text = "No join password is set yet. Set one on a computer (Settings, My machines) to join with a password and an approval."
                        textSize = 12f
                        setPadding(0, 8, 0, 8)
                    })
                }
                for (i in 0 until list.length()) {
                    val row = list.getJSONObject(i)
                    val online = MesaCloud.isOnline(row.optString("lastSeen"), System.currentTimeMillis())
                    val isSelf = row.optString("machineId") == machineId(activity)
                    body.addView(TextView(activity).apply {
                        text = row.optString("displayName") + if (isSelf) " (this phone)" else ""
                        textSize = 16f
                        setTypeface(typeface, android.graphics.Typeface.BOLD)
                        setPadding(0, 28, 0, 0)
                    })
                    body.addView(TextView(activity).apply {
                        text = row.optString("type") + " · " + if (online) "online" else "offline"
                        textSize = 12f
                        alpha = 0.7f
                    })
                    if (isSelf) continue
                    val granted = hasOpenGrant(activity, row)
                    if (granted) {
                        body.addView(MaterialButton(activity).apply {
                            text = "Open drives"
                            isAllCaps = false
                            setOnClickListener { openDrives(activity, row) }
                        })
                        body.addView(MaterialButton(activity, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                            text = "Forget"
                            isAllCaps = false
                            setOnClickListener {
                                thread(name = "mesa-forget") {
                                    MesaReciprocal.forgetPeer(activity, row)
                                    activity.runOnUiThread {
                                        toast(activity, "Forgot that machine.")
                                        showMachines(activity)
                                    }
                                }
                            }
                        })
                    } else {
                        if (directory.locked && row.optString("type") != "phone") {
                            body.addView(MaterialButton(activity).apply {
                                text = "Join"
                                isAllCaps = false
                                setOnClickListener { joinMachine(activity, row, directory.wraps) }
                            })
                        }
                        body.addView(MaterialButton(activity, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                            text = activity.getString(R.string.mesa_connect) + " with a code (shared folders only)"
                            isAllCaps = false
                            setOnClickListener { connect(activity, row) }
                        })
                    }
                    if (row.optString("tailscaleHost").isNotBlank()) {
                        body.addView(MaterialButton(activity, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                            text = "Remote access"
                            isAllCaps = false
                            setOnClickListener { remoteAccessDialog(activity, row) }
                        })
                    }
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
            val token = runCatching {
                if (machine.optString("type") == "phone") code else redeem(url, code, activity)
            }.getOrNull()
            if (token.isNullOrBlank()) {
                activity.runOnUiThread { toast(activity, "That machine refused the code.") }
                return@thread
            }
            val saved = runCatching {
                CredentialVault(activity).save("link-" + machine.optString("machineId"), token)
                CredentialVault(activity).save("link-scope-" + machine.optString("machineId"), "shares")
            }.isSuccess
            activity.runOnUiThread {
                if (!saved) toast(activity, "Paired, but this phone could not save the pairing. Try again.")
                else openDrives(activity, machine)
            }
        }
    }

    /** A saved token that is not known to be shared-folders-only opens the drives without asking again. */
    private fun hasOpenGrant(activity: Activity, machine: JSONObject): Boolean {
        val vault = CredentialVault(activity)
        val id = machine.optString("machineId")
        if (machine.optString("type") == "phone") return false
        if (vault.load("link-$id").isNullOrBlank()) return false
        return vault.load("link-scope-$id").orEmpty() != "shares"
    }

    /** Open a machine this phone already holds a grant for in the full-screen browser. */
    private fun openDrives(activity: Activity, machine: JSONObject) {
        if (MesaCloud.connectionUrl(machine).isEmpty()) {
            toast(activity, "That machine has no Tailscale or LAN address.")
            return
        }
        runCatching { LinkedBrowserActivity.launch(activity, machine) }
            .onFailure { toast(activity, "Could not open the file browser.") }
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
        // HttpURLConnection cannot send PROPFIND on Android (ProtocolException), so use DavClient.
        val auth = Base64.encodeToString("drivebay:$token".toByteArray(), Base64.NO_WRAP)
        val reply = DavClient.propfind(url, auth) ?: return emptyList()
        return if (reply.status == 207) runCatching { MesaCloud.shareNames(reply.body) }.getOrDefault(emptyList()) else emptyList()
    }

    private fun remoteAccessDialog(activity: Activity, machine: JSONObject) {
        val token = CredentialVault(activity).load("link-" + machine.optString("machineId")).orEmpty()
        if (token.isBlank()) {
            toast(activity, "Pair this phone with that computer first.")
            return
        }
        val minutes = android.widget.Spinner(activity)
        minutes.adapter = android.widget.ArrayAdapter(activity, android.R.layout.simple_spinner_dropdown_item, listOf("15 minutes", "1 hour", "4 hours", "24 hours"))
        val mode = android.widget.Spinner(activity)
        mode.adapter = android.widget.ArrayAdapter(activity, android.R.layout.simple_spinner_dropdown_item, listOf("Read-only", "Read-and-write"))
        val box = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 24, 48, 0)
            addView(TextView(activity).apply {
                text = "Turn this computer's regular internet access on from this phone, already on your Tailscale network. It turns itself off after the time you pick."
            })
            addView(minutes)
            addView(mode)
        }
        android.app.AlertDialog.Builder(activity)
            .setTitle("Remote access · " + machine.optString("displayName"))
            .setView(box)
            .setPositiveButton("Turn on") { _, _ ->
                val mins = intArrayOf(15, 60, 240, 1440)[minutes.selectedItemPosition]
                val access = if (mode.selectedItemPosition == 0) "ro" else "rw"
                setRemoteAccess(activity, machine, token, true, mins, access)
            }
            .setNeutralButton("Turn off") { _, _ -> setRemoteAccess(activity, machine, token, false, 15, "rw") }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun setRemoteAccess(activity: Activity, machine: JSONObject, token: String, enabled: Boolean, minutes: Int, mode: String) {
        val url = MesaCloud.connectionUrl(machine)
        if (url.isEmpty() || machine.optString("tailscaleHost").isBlank()) {
            toast(activity, "Turn remote access on from a device that is already on the Tailscale network.")
            return
        }
        thread(name = "mesa-remote-access") {
            val origin = java.net.URI(url).let { "${it.scheme}://${it.authority}" }
            val payload = org.json.JSONObject()
                .put("enabled", enabled)
                .put("minutes", minutes)
                .put("mode", mode)
                .put("machineId", machineId(activity))
                .put("displayName", android.os.Build.MODEL ?: "Phone")
            val text = postWithToken("$origin/api/link/remote-access", payload.toString(), token)
            val json = text?.let { runCatching { JSONObject(it) }.getOrNull() }
            activity.runOnUiThread {
                if (json == null || json.optBoolean("ok") != true && !json.has("enabled")) {
                    toast(activity, json?.optString("error").takeUnless { it.isNullOrBlank() } ?: "That machine did not accept the change.")
                    return@runOnUiThread
                }
                if (json.optBoolean("enabled")) {
                    val countdown = json.optString("countdown")
                    val banner = json.optString("banner")
                    val title = json.optString("title").ifBlank {
                        "Unprotected port forward on — reachable from the internet, outside Tailscale"
                    }
                    val accessMode = json.optString("mode").ifBlank { mode }
                    val modeLabel = if (accessMode == "ro") "read-only" else "read-and-write"
                    android.app.AlertDialog.Builder(activity)
                        .setTitle(title)
                        .setMessage("$countdown left · $modeLabel. $banner")
                        .setPositiveButton(android.R.string.ok, null)
                        .setNeutralButton("Off now") { _, _ ->
                            setRemoteAccess(activity, machine, token, false, 15, "rw")
                        }
                        .show()
                } else {
                    toast(activity, "Unprotected port forward is off.")
                }
            }
        }
    }

    private fun postWithToken(url: String, body: String, token: String): String? {
        val connection = (java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Authorization", "Bearer $token")
            connectTimeout = 8000
            readTimeout = 8000
        }
        return try {
            connection.outputStream.use { it.write(body.toByteArray()) }
            val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
            stream?.bufferedReader()?.readText()
        } catch (_: Exception) {
            null
        } finally {
            connection.disconnect()
        }
    }

    fun register(activity: Activity) {
        thread(name = "mesa-register") { registerBlocking(activity) }
    }

    /** Plain connection info until the list is locked, then an envelope sealed with the account key. */
    private fun registerBlocking(activity: Activity) {
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
        val directory = fetchDirectory(config, session.first, machineId(activity))
        val payload = if (directory?.locked == true) {
            val dek = loadDek(activity) ?: return
            runCatching { MesaVault.encryptDirectory(dek, body) }.getOrNull() ?: return
        } else {
            body
        }
        post(config.cloudApi + "/machines.php", payload.toString(), session.first)
        val dek = loadDek(activity)
        val listed = if (directory?.locked == true) {
            if (dek == null) JSONArray() else openLocked(dek, directory.machines)
        } else {
            directory?.machines ?: JSONArray()
        }
        MesaReciprocal.offerPending(activity, listed)
    }

    private fun refresh(activity: Activity, status: TextView) {
        val session = loadSession(activity)
        val signedIn = session != null
        status.text = if (!signedIn) {
            activity.getString(R.string.mesa_signed_out)
        } else {
            activity.getString(R.string.mesa_signed_in, session?.second)
        }
        val show = if (signedIn) View.GONE else View.VISIBLE
        activity.findViewById<View>(R.id.mesaGoogle).visibility = show
        activity.findViewById<View>(R.id.mesaApple).visibility = show
        activity.findViewById<View>(R.id.mesaEmail).visibility = show
        activity.findViewById<View>(R.id.mesaSignOut).visibility = if (signedIn) View.VISIBLE else View.GONE
    }

    private fun clearSession(activity: Activity) {
        CredentialVault(activity).forget("mesa-refresh")
        activity.getSharedPreferences("drivebay_mesa", Activity.MODE_PRIVATE).edit()
            .remove("idToken")
            .remove("email")
            .apply()
    }

    private fun emailDialog(activity: Activity) {
        val config = loadConfig(activity)
        if (config == null || !config.ready) {
            toast(activity, "Add mesa-firebase.json on this phone. Drivebay keeps working without it.")
            return
        }
        val email = EditText(activity).apply {
            hint = "Email"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
        }
        val password = EditText(activity).apply {
            hint = "Password"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val box = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 24, 48, 0)
            addView(email)
            addView(password)
        }
        android.app.AlertDialog.Builder(activity)
            .setTitle(R.string.mesa_email_title)
            .setMessage("The password is not saved on this phone. If this email already belongs to Google or Apple, use that button.")
            .setView(box)
            .setPositiveButton("Sign in") { _, _ ->
                val typed = password.text?.toString().orEmpty()
                password.setText("")
                runEmail(activity, config, "signIn", email.text?.toString().orEmpty(), typed)
            }
            .setNegativeButton("Create account") { _, _ ->
                val typed = password.text?.toString().orEmpty()
                password.setText("")
                runEmail(activity, config, "signUp", email.text?.toString().orEmpty(), typed)
            }
            .setNeutralButton("Reset password") { _, _ ->
                password.setText("")
                runEmail(activity, config, "reset", email.text?.toString().orEmpty(), "")
            }
            .show()
    }

    private fun runEmail(activity: Activity, config: MesaCloud.Config, action: String, email: String, password: String) {
        thread(name = "mesa-email") {
            val text = postAny(MesaCloud.emailAuthUrl(config, action), MesaCloud.emailAuthBody(action, email, password))
            val json = text?.let { runCatching { JSONObject(it) }.getOrNull() }
            val error = json?.optJSONObject("error")?.optString("message").orEmpty()
            activity.runOnUiThread {
                if (action == "reset") {
                    toast(activity, "If this email can receive mail from Mesa and Moon, a reset link is on its way.")
                    return@runOnUiThread
                }
                if (json == null || error.isNotBlank()) {
                    if (action == "signUp" && error.contains("EMAIL_EXISTS")) {
                        toast(activity, MesaCloud.providerConflictMessage(emptyList()))
                    } else if (error.contains("WEAK_PASSWORD")) {
                        toast(activity, "Use a password of at least 8 characters.")
                    } else {
                        toast(activity, "That email or password was not accepted.")
                    }
                    return@runOnUiThread
                }
                val session = MesaCloud.emailSession(json)
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
        if (existing.isNotBlank() && MachineKeys.looksLikePublicKey(existing) && !CredentialVault(activity).load("mesa-machine-private").isNullOrBlank()) {
            return existing
        }
        val created = MachineKeys.generate()
        CredentialVault(activity).save("mesa-machine-private", created.privateKey)
        prefs.edit().putString("publicKey", created.publicKey).apply()
        return created.publicKey
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

    private class Directory(val machines: JSONArray, val locked: Boolean, val wraps: JSONArray)

    private fun fetchDirectory(config: MesaCloud.Config, idToken: String, self: String): Directory? {
        val text = get(config.cloudApi + "/machines.php?self=" + self, idToken) ?: return null
        return runCatching {
            val json = JSONObject(text)
            Directory(
                json.optJSONArray("machines") ?: JSONArray(),
                json.optBoolean("locked", false),
                json.optJSONArray("wraps") ?: JSONArray(),
            )
        }.getOrNull()
    }

    /** Open each sealed record. A record this key cannot open is skipped, not fatal. */
    private fun openLocked(dek: ByteArray, machines: JSONArray): JSONArray {
        val out = JSONArray()
        for (i in 0 until machines.length()) {
            val row = machines.optJSONObject(i) ?: continue
            if (row.optInt("envelopeVersion") == 2 && row.optString("ciphertext").isNotBlank()) {
                runCatching { MesaVault.decryptDirectory(dek, row) }.getOrNull()?.let { out.put(it) }
            } else {
                out.put(row)
            }
        }
        return out
    }

    private fun loadDek(activity: Activity): ByteArray? {
        val text = CredentialVault(activity).load("mesa-dek").orEmpty()
        if (text.isBlank()) return null
        return runCatching { MesaVault.fromB64(text) }.getOrNull()?.takeIf { it.size == 32 }
    }

    private fun saveDek(activity: Activity, dek: ByteArray) {
        CredentialVault(activity).save("mesa-dek", MesaVault.b64(dek))
    }

    private fun askJoinPassword(activity: Activity, wraps: JSONArray, done: () -> Unit) {
        val input = EditText(activity).apply {
            hint = "Join password"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        android.app.AlertDialog.Builder(activity)
            .setTitle("Enter your join password")
            .setMessage("Your machine list is encrypted. The password is not saved. Only the key it opens stays on this phone.")
            .setView(input)
            .setPositiveButton("Unlock") { _, _ ->
                val typed = input.text?.toString().orEmpty()
                thread(name = "mesa-unlock") {
                    val dek = MesaJoin.unlockWithPassword(wraps, typed)
                    if (dek == null) {
                        activity.runOnUiThread { toast(activity, "That join password did not open your machine list.") }
                    } else {
                        saveDek(activity, dek)
                        registerBlocking(activity)
                        activity.runOnUiThread { done() }
                    }
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun postJson(url: String, body: String): Pair<Int, String> {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            connectTimeout = 8000
            readTimeout = 8000
        }
        return try {
            connection.outputStream.use { it.write(body.toByteArray()) }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            code to (stream?.bufferedReader()?.readText().orEmpty())
        } catch (_: Exception) {
            0 to ""
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Join a machine on this login: send the join password proof and a device-key signature,
     * then wait for a trusted device on that machine to approve. Only then does this phone get a token.
     */
    private fun joinMachine(activity: Activity, machine: JSONObject, wraps: JSONArray) {
        val url = MesaCloud.connectionUrl(machine)
        if (url.isEmpty()) {
            toast(activity, "That machine has no Tailscale or LAN address.")
            return
        }
        val dek = loadDek(activity)
        if (dek == null) {
            askJoinPassword(activity, wraps) { joinMachine(activity, machine, wraps) }
            return
        }
        val origin = url.substringBefore("/dav").trimEnd('/')
        val hostId = machine.optString("machineId")
        val me = machineId(activity)
        val privateKey = CredentialVault(activity).load("mesa-machine-private").orEmpty()
        if (privateKey.isBlank()) {
            toast(activity, "This phone has no device key yet. Sign in again.")
            return
        }
        val cancelled = java.util.concurrent.atomic.AtomicBoolean(false)
        val waiting = android.app.AlertDialog.Builder(activity)
            .setTitle(machine.optString("displayName"))
            .setMessage("Waiting for a trusted device on ${machine.optString("displayName")} to approve this phone. Open Drivebay Settings there, My machines, and tap Approve.")
            .setNegativeButton(android.R.string.cancel) { _, _ -> cancelled.set(true) }
            .setCancelable(false)
            .show()
        thread(name = "mesa-join") {
            fun finish(message: String) = activity.runOnUiThread {
                waiting.dismiss()
                toast(activity, message)
            }
            val secret = MesaJoin.newSecret()
            val request = runCatching {
                JSONObject()
                    .put("machineId", me)
                    .put("displayName", android.os.Build.MODEL ?: "Phone")
                    .put("secret", secret)
                    .put("proof", MesaJoin.proof(dek, hostId, me, secret))
                    .put("signature", MesaJoin.signature(privateKey, hostId, me, secret))
            }.getOrNull()
            if (request == null) {
                finish("Could not build the join request on this phone.")
                return@thread
            }
            val (status, text) = postJson("$origin/api/link/request", request.toString())
            val asked = runCatching { JSONObject(text) }.getOrNull()
            val id = asked?.optString("id").orEmpty()
            if (status != 200 || id.isBlank()) {
                finish(asked?.optString("error")?.takeIf { it.isNotBlank() } ?: "That machine did not take the join request.")
                return@thread
            }
            val deadline = System.currentTimeMillis() + 10 * 60 * 1000
            while (!cancelled.get() && System.currentTimeMillis() < deadline) {
                Thread.sleep(3000)
                val polled = postJson("$origin/api/link/poll", JSONObject().put("id", id).put("secret", secret).toString())
                if (polled.first == 200) {
                    val answer = runCatching { JSONObject(polled.second) }.getOrNull()
                    val token = answer?.optString("token").orEmpty()
                    if (token.isBlank()) continue
                    val full = answer?.optString("scope") == "full"
                    runCatching {
                        CredentialVault(activity).save("link-" + hostId, token)
                        CredentialVault(activity).save("link-scope-" + hostId, if (full) "full" else "shares")
                    }
                    if (full) runCatching { MesaReciprocal.offerTo(activity, machine, token) }
                    activity.runOnUiThread {
                        waiting.dismiss()
                        toast(activity, if (full) "Trusted. Opening all drives on this machine." else "Connected. Shared folders only.")
                        if (full && MesaReciprocal.needsAllFiles(activity)) promptAllFiles(activity)
                        openDrives(activity, machine)
                    }
                    return@thread
                }
            }
            if (!cancelled.get()) finish("Nobody approved this phone in time. Ask again.")
        }
    }

    private fun postAny(url: String, body: String): String? {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            connectTimeout = 8000
            readTimeout = 8000
        }
        return try {
            connection.outputStream.use { it.write(body.toByteArray()) }
            val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
            stream?.bufferedReader()?.readText()
        } catch (_: Exception) {
            null
        } finally {
            connection.disconnect()
        }
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

    private fun promptAllFiles(activity: Activity) {
        if (activity is MainActivity) {
            activity.requestLinkAllFiles()
            return
        }
        toast(activity, "Allow all-files access so trusted computers can open this phone's storage.")
    }

    private fun toast(activity: Activity, message: String) {
        Toast.makeText(activity, message, Toast.LENGTH_LONG).show()
    }
}
