package com.lordstryfe.drivebay.license

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.InputType
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.lordstryfe.drivebay.MesaPanel
import java.text.DateFormat
import java.util.Date
import kotlin.concurrent.thread

/** Settings → Edition on the phone: current edition, enter a purchase code, refresh, deactivate. */
object EditionPanel {
    private fun manager(activity: Activity) = Editions.manager(activity) { MesaPanel.machineId(activity) }

    fun currentEdition(activity: Activity): EditionState = manager(activity).state()

    /** Friendly upgrade dialog with a way to enter a code and a link to the editions page. */
    fun showUpgrade(activity: Activity, feature: String) {
        val state = currentEdition(activity)
        AlertDialog.Builder(activity)
            .setTitle("Upgrade to unlock this")
            .setMessage(EditionPolicy.upgradeMessage(feature, state.edition))
            .setPositiveButton("Enter a code") { _, _ -> show(activity) }
            .setNeutralButton("See the editions") { _, _ ->
                runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(LicenseConfig.UPGRADE_URL))) }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    fun show(activity: Activity) {
        val state = manager(activity).state()
        val date = DateFormat.getDateInstance(DateFormat.MEDIUM)
        val lines = StringBuilder()
        lines.append("Edition: ").append(state.name)
        val license = state.license
        if (state.status == "active" && license != null) {
            if (license.label.isNotBlank()) lines.append(" · ").append(license.label)
            lines.append("\n").append(license.seats).append(if (license.seats == 1) " device" else " devices").append(" on this license")
            lines.append("\n").append(license.expires?.let { "Renews or ends " + date.format(Date(it * 1000)) } ?: "Does not expire")
            lines.append("\n").append(license.updatesUntil?.let { "Updates included until " + date.format(Date(it * 1000)) } ?: "Updates included for life")
            if (license.offline) lines.append("\nOffline license (no check-in needed)")
        } else if (state.edition == "free") {
            lines.append("\n\nFree links all your own machines, mounts them as drives, and shares up to 3 folders. Pro and Elite add time-limited remote access, public access over your own port forward, and more shared folders.")
        }
        if (state.detail.isNotBlank()) lines.append("\n\n").append(state.detail)
        val input = EditText(activity).apply {
            hint = "DBAY-XXXX-XXXX-XXXX-XXXX"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            maxLines = 4
            val clip = (activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager)?.primaryClip?.getItemAt(0)?.text?.toString().orEmpty()
            if (LicenseCodec.classify(clip).isNotEmpty()) setText(clip.trim())
        }
        val box = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 24, 48, 0)
            addView(TextView(activity).apply { text = lines.toString() })
            addView(input)
            addView(TextView(activity).apply {
                textSize = 12f
                text = "Activation sends the code, a random phone id and this phone's model to Mesa and Moon so seats can be counted. It never sends file names or contents."
            })
        }
        val builder = AlertDialog.Builder(activity)
            .setTitle("Edition and license")
            .setView(box)
            .setPositiveButton("Activate") { _, _ ->
                val text = input.text.toString()
                runAsync(activity, "Activating…") { manager(activity).activate(text) }
            }
            .setNegativeButton(android.R.string.cancel, null)
        if (state.license != null) {
            builder.setNeutralButton("More") { _, _ -> more(activity, state) }
        } else {
            builder.setNeutralButton("See the editions") { _, _ ->
                runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(LicenseConfig.UPGRADE_URL))) }
            }
        }
        builder.show()
    }

    private fun more(activity: Activity, state: EditionState) {
        val items = if (state.license?.offline == true) arrayOf("Deactivate this phone") else arrayOf("Refresh now", "Deactivate this phone")
        AlertDialog.Builder(activity)
            .setItems(items) { _, which ->
                val label = items[which]
                if (label.startsWith("Refresh")) runAsync(activity, "Refreshing…") { manager(activity).refresh() }
                else runAsync(activity, "Deactivating…") {
                    val soft = manager(activity).deactivate(false)
                    if (!soft.ok && soft.code == "network") manager(activity).deactivate(true) else soft
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun runAsync(activity: Activity, working: String, work: () -> ActionResult) {
        Toast.makeText(activity, working, Toast.LENGTH_SHORT).show()
        thread(name = "drivebay-license") {
            val result = work()
            activity.runOnUiThread {
                val extra = if (result.devices.isNotEmpty()) " In use on: " + result.devices.joinToString(", ") + "." else ""
                Toast.makeText(activity, result.message + extra, Toast.LENGTH_LONG).show()
            }
        }
    }
}
