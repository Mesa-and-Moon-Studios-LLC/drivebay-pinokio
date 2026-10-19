package com.mesaandmoon.update

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.pm.PackageInfoCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.lifecycleScope
import com.google.android.play.core.appupdate.AppUpdateInfo
import com.google.android.play.core.appupdate.AppUpdateManager
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability
import com.google.android.play.core.ktx.requestAppUpdateInfo
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

/**
 * Mesa and Moon shared update check (same file in every Android app; see README in mm-update-check).
 *
 * One line in the launcher activity's onCreate:
 *     AppUpdateGate.attach(this, "https://example.mesaandmoon.com/app-version.json")
 *
 * On every resume it asks Google Play whether a newer build exists. Only when Play says yes does it read
 * the version file from our server and decide (see [UpdatePolicy]):
 *  - required: full-screen "Update required" screen + Play IMMEDIATE flow. Backing out keeps the app blocked.
 *  - optional: small dismissible banner; "Update" runs the Play FLEXIBLE flow, then "Restart" installs it.
 * Sideloaded / debug installs, offline, or an unreadable file: does nothing (fail open).
 */
class AppUpdateGate private constructor(
    private val activity: ComponentActivity,
    private val configUrl: String,
) : DefaultLifecycleObserver {

    private val manager: AppUpdateManager = AppUpdateManagerFactory.create(activity.applicationContext)
    private val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val enabled: Boolean = installedFromPlay(activity)
    private val installed: Long = installedVersionCode(activity)

    private val launcher: ActivityResultLauncher<IntentSenderRequest> =
        activity.registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { r ->
            onFlowResult(r.resultCode)
        }

    private var checking = false
    private var pendingFlow: Int? = null
    private var skipNextAutoPrompt = false
    private var listenerRegistered = false
    private var blocker: View? = null
    private var blockerText: TextView? = null
    private var banner: View? = null
    private var backBlock: OnBackPressedCallback? = null

    private val installListener = InstallStateUpdatedListener { state ->
        if (state.installStatus() == InstallStatus.DOWNLOADED) showRestartBanner()
    }

    init {
        activity.lifecycle.addObserver(this)
    }

    override fun onResume(owner: LifecycleOwner) {
        if (enabled) check(autoPrompt = true)
    }

    override fun onDestroy(owner: LifecycleOwner) {
        if (listenerRegistered) {
            runCatching { manager.unregisterListener(installListener) }
            listenerRegistered = false
        }
    }

    private fun check(autoPrompt: Boolean) {
        if (checking) return
        checking = true
        activity.lifecycleScope.launch {
            try {
                val info = runCatching { manager.requestAppUpdateInfo() }.getOrNull() ?: return@launch
                if (info.installStatus() == InstallStatus.DOWNLOADED) {
                    showRestartBanner()
                    return@launch
                }
                // An IMMEDIATE update was started earlier and the user left the app: resume it.
                if (info.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS) {
                    showBlocker(prefs.getString(KEY_LAST_MESSAGE, null))
                    startFlow(info, AppUpdateType.IMMEDIATE)
                    return@launch
                }
                val playHasUpdate = info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE
                if (!playHasUpdate) {
                    hideBlocker()
                    return@launch
                }
                val config = withContext(Dispatchers.IO) { fetchConfig() }
                when (
                    UpdatePolicy.decide(
                        installed, config, playHasUpdate,
                        info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE),
                        info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE),
                    )
                ) {
                    UpdateAction.REQUIRED -> {
                        prefs.edit().putString(KEY_LAST_MESSAGE, config?.message).apply()
                        hideBanner()
                        showBlocker(config?.message)
                        if (autoPrompt && skipNextAutoPrompt) {
                            skipNextAutoPrompt = false // just backed out: show the screen, prompt again next time
                        } else {
                            skipNextAutoPrompt = false
                            startFlow(info, AppUpdateType.IMMEDIATE)
                        }
                    }
                    UpdateAction.OPTIONAL -> {
                        hideBlocker()
                        val vc = info.availableVersionCode().toLong()
                        if (prefs.getLong(KEY_DISMISSED, -1L) != vc) showOptionalBanner(info, vc)
                    }
                    UpdateAction.NONE -> hideBlocker()
                }
            } finally {
                checking = false
            }
        }
    }

    private fun startFlow(info: AppUpdateInfo, type: Int) {
        val ok = runCatching {
            manager.startUpdateFlowForResult(info, launcher, AppUpdateOptions.newBuilder(type).build())
        }.getOrDefault(false)
        if (ok) pendingFlow = type
    }

    private fun onFlowResult(resultCode: Int) {
        val type = pendingFlow
        pendingFlow = null
        if (type == AppUpdateType.IMMEDIATE) {
            // Play restarts the app itself after a successful install. Anything else = user backed out or it failed:
            // stay blocked; the next return to the app prompts again, and "Update now" retries at once.
            if (resultCode != Activity.RESULT_OK) skipNextAutoPrompt = true
        } else if (type == AppUpdateType.FLEXIBLE) {
            if (resultCode == Activity.RESULT_OK) {
                hideBanner()
            } else {
                rememberDismiss()
                hideBanner()
            }
        }
    }

    private fun fetchConfig(): VersionConfig? {
        val sep = if (configUrl.contains('?')) '&' else '?'
        val conn = runCatching {
            URL("$configUrl${sep}t=${System.currentTimeMillis() / 60_000}").openConnection() as HttpURLConnection
        }.getOrNull() ?: return null
        return try {
            conn.connectTimeout = 5_000
            conn.readTimeout = 5_000
            conn.useCaches = false
            conn.instanceFollowRedirects = true
            conn.setRequestProperty("Cache-Control", "no-cache")
            conn.setRequestProperty("Accept", "application/json")
            if (conn.responseCode !in 200..299) return null
            val bytes = conn.inputStream.use { input ->
                val buf = java.io.ByteArrayOutputStream()
                val chunk = ByteArray(8192)
                while (true) {
                    val n = input.read(chunk)
                    if (n < 0) break
                    buf.write(chunk, 0, n)
                    if (buf.size() > UpdatePolicy.MAX_BYTES) return null
                }
                buf.toByteArray()
            }
            UpdatePolicy.parse(String(bytes, Charsets.UTF_8))
        } catch (_: Exception) {
            null
        } finally {
            conn.disconnect()
        }
    }

    private fun rememberDismiss() {
        // Dismissal is remembered per Play version, so the banner returns only for the next release.
        val vc = prefs.getLong(KEY_OFFERED, -1L)
        if (vc >= 0) prefs.edit().putLong(KEY_DISMISSED, vc).apply()
    }

    // ---- UI (built in code so the file can be copied to any app without resources) ----

    private fun content(): FrameLayout = activity.findViewById(android.R.id.content)

    private fun dp(v: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), activity.resources.displayMetrics).toInt()

    private fun appName(): String =
        runCatching { activity.applicationInfo.loadLabel(activity.packageManager).toString() }.getOrDefault("this app")

    private fun button(text: String, primary: Boolean, onClick: () -> Unit): Button =
        Button(activity).apply {
            this.text = text
            isAllCaps = false
            setTextColor(if (primary) Color.parseColor("#0F1218") else Color.parseColor("#E8EEF7"))
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                if (primary) setColor(Color.parseColor("#F2C94C"))
                else { setColor(Color.TRANSPARENT); setStroke(dp(1), Color.parseColor("#64748B")) }
            }
            backgroundTintList = null // keep our colors even under Material themes
            setPadding(dp(18), dp(10), dp(18), dp(10))
            setOnClickListener { onClick() }
        }

    private fun applyBarPadding(v: View, extra: Int) {
        ViewCompat.setOnApplyWindowInsetsListener(v) { view, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(b.left + extra, b.top + extra, b.right + extra, b.bottom + extra)
            insets
        }
        v.setPadding(extra, extra, extra, extra)
        ViewCompat.requestApplyInsets(v)
    }

    private fun showBlocker(message: String?) {
        val text = message?.takeIf { it.isNotBlank() }
            ?: "This version of ${appName()} is out of date. Update to keep playing."
        blockerText?.let { it.text = text; return }
        val title = TextView(activity).apply {
            this.text = "Update required"
            setTextColor(Color.parseColor("#E8EEF7"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
        }
        val body = TextView(activity).apply {
            this.text = text
            setTextColor(Color.parseColor("#CBD5E1"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            gravity = Gravity.CENTER
            setLineSpacing(0f, 1.2f)
        }
        val column = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            addView(title)
            addView(body, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(14) })
            addView(button("Update now", true) { check(autoPrompt = false) },
                LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(28) })
            addView(button("Close app", false) { activity.finishAffinity() },
                LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(10) })
        }
        val overlay = FrameLayout(activity).apply {
            setBackgroundColor(Color.parseColor("#F20F1218"))
            isClickable = true // swallow every touch so the app underneath can't be used
            isFocusable = true
            elevation = dp(24).toFloat()
            addView(column, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER))
        }
        applyBarPadding(overlay, dp(28))
        content().addView(overlay, FrameLayout.LayoutParams(-1, -1))
        overlay.requestFocus()
        blocker = overlay
        blockerText = body
        // Added last so it outranks the app's own back handling while blocked.
        backBlock = object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { activity.moveTaskToBack(true) }
        }.also { activity.onBackPressedDispatcher.addCallback(activity, it) }
    }

    private fun hideBlocker() {
        blocker?.let { (it.parent as? ViewGroup)?.removeView(it) }
        blocker = null
        blockerText = null
        backBlock?.remove()
        backBlock = null
    }

    private fun showBanner(text: String, action: String, onAction: () -> Unit, dismissible: Boolean) {
        hideBanner()
        val label = TextView(activity).apply {
            this.text = text
            setTextColor(Color.parseColor("#E8EEF7"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        }
        val row = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = GradientDrawable().apply {
                cornerRadius = dp(14).toFloat()
                setColor(Color.parseColor("#EE1E2533"))
                setStroke(dp(1), Color.parseColor("#F2C94C"))
            }
            setPadding(dp(14), dp(8), dp(8), dp(8))
            elevation = dp(12).toFloat()
            isClickable = true
            addView(label, LinearLayout.LayoutParams(0, -2, 1f))
            addView(button(action, true, onAction), LinearLayout.LayoutParams(-2, -2).apply { marginStart = dp(8) })
            if (dismissible) {
                addView(TextView(activity).apply {
                    this.text = "✕"
                    contentDescription = "Dismiss"
                    setTextColor(Color.parseColor("#94A3B8"))
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
                    setPadding(dp(12), dp(6), dp(6), dp(6))
                    setOnClickListener { rememberDismiss(); hideBanner() }
                })
            }
        }
        val holder = FrameLayout(activity).apply {
            elevation = dp(20).toFloat()
            addView(row, FrameLayout.LayoutParams(-1, -2))
        }
        applyBarPadding(holder, dp(10))
        content().addView(holder, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))
        banner = holder
    }

    private fun hideBanner() {
        banner?.let { (it.parent as? ViewGroup)?.removeView(it) }
        banner = null
    }

    private fun showOptionalBanner(info: AppUpdateInfo, versionCode: Long) {
        if (banner != null) return
        prefs.edit().putLong(KEY_OFFERED, versionCode).apply()
        showBanner("A new version of ${appName()} is ready.", "Update", {
            if (!listenerRegistered) {
                manager.registerListener(installListener)
                listenerRegistered = true
            }
            startFlow(info, AppUpdateType.FLEXIBLE)
            hideBanner()
        }, dismissible = true)
    }

    private fun showRestartBanner() {
        hideBlocker()
        showBanner("Update downloaded.", "Restart", { manager.completeUpdate() }, dismissible = false)
    }

    companion object {
        private const val PREFS = "mm_update_gate"
        private const val KEY_DISMISSED = "dismissed_version_code"
        private const val KEY_OFFERED = "offered_version_code"
        private const val KEY_LAST_MESSAGE = "last_required_message"

        /** Call once from the launcher activity's onCreate (after super.onCreate). */
        @JvmStatic
        fun attach(activity: ComponentActivity, configUrl: String): AppUpdateGate =
            AppUpdateGate(activity, configUrl)

        fun installedFromPlay(context: Context): Boolean = runCatching {
            val pm = context.packageManager
            val installer = if (Build.VERSION.SDK_INT >= 30) {
                pm.getInstallSourceInfo(context.packageName).installingPackageName
            } else {
                @Suppress("DEPRECATION")
                pm.getInstallerPackageName(context.packageName)
            }
            UpdatePolicy.isPlayInstaller(installer)
        }.getOrDefault(false)

        fun installedVersionCode(context: Context): Long = runCatching {
            PackageInfoCompat.getLongVersionCode(context.packageManager.getPackageInfo(context.packageName, 0))
        }.getOrDefault(Long.MAX_VALUE) // unknown version: never force
    }
}
