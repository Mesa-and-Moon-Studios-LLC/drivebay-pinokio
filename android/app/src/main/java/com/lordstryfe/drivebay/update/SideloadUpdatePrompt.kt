package com.lordstryfe.drivebay.update

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.appcompat.app.AlertDialog
import androidx.core.content.pm.PackageInfoCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import com.lordstryfe.drivebay.R
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Sideloaded copies (installer is not Play) look at the latest GitHub release.
 * A newer APK shows the same "Update available" prompt as Play, then the
 * package installer. Checks on launch and on resume, at most once per 12 hours.
 */
class SideloadUpdatePrompt private constructor(
    private val activity: ComponentActivity,
) : DefaultLifecycleObserver {

    private val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val source = UpdateInstaller.source(activity)
    private var checking = false
    private var downloading = false
    private var banner: View? = null
    private var dialog: AlertDialog? = null

    init {
        activity.lifecycle.addObserver(this)
        // Launch. onResume repeats the check; the 12 hour throttle and [checking] keep it to one request.
        maybeCheck(force = false, report = null)
    }

    override fun onResume(owner: LifecycleOwner) {
        maybeCheck(force = false, report = null)
    }

    override fun onDestroy(owner: LifecycleOwner) {
        dialog?.dismiss()
        dialog = null
        hideBanner()
    }

    /** Settings. Ignores the 12 hour throttle. Returns false when a check is already running. */
    fun checkNow(report: (UpdateCheckResult) -> Unit): Boolean {
        if (source != UpdateSource.SIDELOAD || checking) return false
        maybeCheck(force = true, report = report)
        return true
    }

    private fun maybeCheck(force: Boolean, report: ((UpdateCheckResult) -> Unit)?) {
        if (source != UpdateSource.SIDELOAD) return
        val now = System.currentTimeMillis()
        if (!UpdateVersions.shouldCheck(prefs.getLong(KEY_LAST, 0L), now, force)) return
        if (checking) return
        checking = true
        activity.lifecycleScope.launch {
            val looked = withContext(Dispatchers.IO) { runCatching { lookup() }.getOrNull() }
            prefs.edit().putLong(KEY_LAST, System.currentTimeMillis()).apply()
            checking = false
            if (activity.isDestroyed) return@launch
            val offer = looked?.offer
            when {
                looked == null || looked.failed -> report?.invoke(UpdateCheckResult.FAILED)
                offer == null -> {
                    if (force) hidePrompt()
                    report?.invoke(UpdateCheckResult.UP_TO_DATE)
                }
                else -> {
                    if (force || offer.required || prefs.getLong(KEY_DISMISSED, -1L) != offer.versionCode) {
                        showPrompt(offer)
                    }
                    report?.invoke(UpdateCheckResult.UPDATE_AVAILABLE)
                }
            }
        }
    }

    private fun lookup(): Lookup {
        val releaseJson = GithubUpdateClient.fetchReleaseJson() ?: return Lookup(null, failed = true)
        val release = UpdateVersions.parseRelease(releaseJson) ?: return Lookup(null, failed = true)
        val manifest = manifestOf(release)
        val offer = UpdateVersions.resolveOffer(installedVersionCode(), release, manifest)
        return Lookup(offer, failed = false)
    }

    private fun manifestOf(release: UpdateVersions.ReleaseListing): UpdateVersions.Manifest? {
        val asset = UpdateVersions.manifestAsset(release) ?: return null
        if (!UpdateVersions.isAllowedDownloadUrl(asset.downloadUrl)) return null
        val text = GithubUpdateClient.fetchText(asset.downloadUrl, UpdateVersions.MAX_MANIFEST_BYTES) ?: return null
        return UpdateVersions.parseManifest(text)
    }

    private fun installedVersionCode(): Long = runCatching {
        PackageInfoCompat.getLongVersionCode(activity.packageManager.getPackageInfo(activity.packageName, 0))
    }.getOrDefault(Long.MAX_VALUE)

    private fun showPrompt(offer: UpdateVersions.ApkOffer) {
        if (offer.required) showDialog(offer) else showBanner(offer)
    }

    private fun showDialog(offer: UpdateVersions.ApkOffer) {
        if (dialog?.isShowing == true) return
        hideBanner()
        dialog = AlertDialog.Builder(activity)
            .setTitle(UpdateVersions.PROMPT_TITLE)
            .setMessage(offer.versionName?.let { "Version $it is ready." } ?: "A new version of Drivebay is ready.")
            .setPositiveButton(UpdateVersions.PROMPT_ACTION) { _, _ -> downloadAndInstall(offer) }
            .setCancelable(false)
            .setOnDismissListener { dialog = null }
            .show()
    }

    private fun showBanner(offer: UpdateVersions.ApkOffer) {
        if (banner != null) return
        hideDialog()
        val label = TextView(activity).apply {
            text = UpdateVersions.PROMPT_TITLE
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
            addView(actionButton(UpdateVersions.PROMPT_ACTION) { downloadAndInstall(offer) },
                LinearLayout.LayoutParams(-2, -2).apply { marginStart = dp(8) })
            if (!offer.required) {
                addView(TextView(activity).apply {
                    text = "✕"
                    contentDescription = "Dismiss"
                    setTextColor(Color.parseColor("#94A3B8"))
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
                    setPadding(dp(12), dp(6), dp(6), dp(6))
                    setOnClickListener {
                        prefs.edit().putLong(KEY_DISMISSED, offer.versionCode).apply()
                        hideBanner()
                    }
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

    private fun downloadAndInstall(offer: UpdateVersions.ApkOffer) {
        if (downloading) return
        if (!ApkInstaller.canInstall(activity)) {
            Toast.makeText(activity, activity.getString(R.string.update_install_permission), Toast.LENGTH_LONG).show()
            runCatching { activity.startActivity(ApkInstaller.unknownSourcesIntent(activity)) }
            return
        }
        downloading = true
        Toast.makeText(activity, activity.getString(R.string.update_downloading), Toast.LENGTH_SHORT).show()
        activity.lifecycleScope.launch {
            val dest = File(activity.cacheDir, "updates/drivebay-update.apk")
            val ok = withContext(Dispatchers.IO) {
                runCatching { GithubUpdateClient.download(offer.downloadUrl, dest) }.getOrDefault(false)
            }
            downloading = false
            if (activity.isDestroyed) return@launch
            if (!ok || !dest.isFile) {
                dest.delete()
                Toast.makeText(activity, activity.getString(R.string.update_download_failed), Toast.LENGTH_LONG).show()
                return@launch
            }
            val opened = runCatching { activity.startActivity(ApkInstaller.installIntent(activity, dest)) }.isSuccess
            if (!opened) {
                Toast.makeText(activity, activity.getString(R.string.update_download_failed), Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun actionButton(text: String, onClick: () -> Unit): Button =
        Button(activity).apply {
            this.text = text
            isAllCaps = false
            setTextColor(Color.parseColor("#0F1218"))
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                setColor(Color.parseColor("#F2C94C"))
            }
            backgroundTintList = null
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

    private fun content(): FrameLayout = activity.findViewById(android.R.id.content)

    private fun dp(v: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), activity.resources.displayMetrics).toInt()

    private fun hideBanner() {
        banner?.let { (it.parent as? ViewGroup)?.removeView(it) }
        banner = null
    }

    private fun hideDialog() {
        dialog?.dismiss()
        dialog = null
    }

    private fun hidePrompt() {
        hideBanner()
        hideDialog()
    }

    private data class Lookup(val offer: UpdateVersions.ApkOffer?, val failed: Boolean)

    companion object {
        private const val PREFS = "drivebay_sideload_update"
        private const val KEY_LAST = "last_check_at"
        private const val KEY_DISMISSED = "dismissed_version_code"

        @JvmStatic
        fun attach(activity: ComponentActivity): SideloadUpdatePrompt = SideloadUpdatePrompt(activity)
    }
}
