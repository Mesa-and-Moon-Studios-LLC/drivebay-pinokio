package com.lordstryfe.drivebay

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.text.InputType
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Full-screen file browser for a machine this phone has a grant for.
 * Drives first, then folders and files, over the host's own WebDAV with the saved grant token.
 * Every network call runs off the main thread and catches its errors.
 * Write actions disappear once the host refuses them (read-only grant, or a switch turned off on that machine).
 */
class LinkedBrowserActivity : AppCompatActivity() {
    private enum class Mode { OPEN, SHARE, SAVE }

    private var session: DavSession? = null
    private var machineId = ""
    private var machineName = ""
    private var path = DavBrowse.ROOT
    private var entries: List<DavBrowse.Entry> = emptyList()
    private var generation = 0
    private var transfers = 0

    private lateinit var titleView: TextView
    private lateinit var uploadBtn: TextView
    private lateinit var folderBtn: TextView
    private lateinit var crumbScroll: HorizontalScrollView
    private lateinit var crumbRow: LinearLayout
    private lateinit var list: ListView
    private lateinit var status: TextView
    private lateinit var loadingBar: ProgressBar
    private lateinit var pull: PullRefresh

    private val picker = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        if (!uris.isNullOrEmpty()) upload(uris)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        machineId = intent?.getStringExtra(EXTRA_MACHINE_ID).orEmpty()
        machineName = intent?.getStringExtra(EXTRA_NAME).orEmpty().ifBlank { "Machine" }
        val url = intent?.getStringExtra(EXTRA_URL).orEmpty()
        val token = runCatching { CredentialVault(this).load("link-$machineId") }.getOrNull().orEmpty()
        if (url.isBlank() || token.isBlank()) {
            Toast.makeText(this, "This phone is not joined to that machine yet.", Toast.LENGTH_LONG).show()
            finish()
            return
        }
        session = DavSession(url, token)
        buildUi()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = goUp()
        })
        load(DavBrowse.ROOT)
    }

    // ---- UI ----

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun accentButton(label: String, click: () -> Unit) = TextView(this).apply {
        text = label
        setTextColor(ACCENT)
        textSize = 14f
        setTypeface(typeface, Typeface.BOLD)
        setPadding(dp(10), dp(12), dp(10), dp(12))
        setOnClickListener { click() }
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BG)
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        val toolbar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(SURFACE)
            setPadding(dp(4), 0, dp(4), 0)
        }
        toolbar.addView(TextView(this).apply {
            text = "\u2190"
            textSize = 24f
            setTextColor(TEXT)
            setPadding(dp(14), dp(10), dp(14), dp(10))
            contentDescription = "Back"
            setOnClickListener { goUp() }
        })
        titleView = TextView(this).apply {
            text = machineName
            textSize = 18f
            setTextColor(TEXT)
            setTypeface(typeface, Typeface.BOLD)
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }
        toolbar.addView(titleView, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        folderBtn = accentButton("New folder") { newFolder() }
        uploadBtn = accentButton("Upload") { picker.launch("*/*") }
        toolbar.addView(folderBtn)
        toolbar.addView(uploadBtn)
        root.addView(toolbar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)))

        crumbRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), 0, dp(12), 0)
        }
        crumbScroll = HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            setBackgroundColor(BG)
            addView(crumbRow, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(40)))
        }
        root.addView(crumbScroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(40)))

        loadingBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true
            visibility = View.INVISIBLE
        }
        root.addView(loadingBar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)))

        list = ListView(this).apply {
            divider = ColorDrawable(DIVIDER)
            dividerHeight = 1
            selector = ColorDrawable(0x22FFFFFF)
            setBackgroundColor(BG)
            adapter = Adapter()
            setOnItemClickListener { _, _, position, _ -> entries.getOrNull(position)?.let(::onTap) }
            setOnItemLongClickListener { _, _, position, _ ->
                entries.getOrNull(position)?.let(::onLongPress)
                true
            }
        }
        status = TextView(this).apply {
            textSize = 15f
            setTextColor(MUTED)
            gravity = Gravity.CENTER
            setPadding(dp(32), dp(32), dp(32), dp(32))
            visibility = View.GONE
        }
        pull = PullRefresh(this, { list }) { refresh() }
        pull.addView(list, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val frame = FrameLayout(this)
        frame.addView(pull, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        frame.addView(status, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        root.addView(frame, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
        updateChrome()
    }

    private inner class Adapter : BaseAdapter() {
        override fun getCount() = entries.size
        override fun getItem(position: Int) = entries[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
            val row = convertView as? LinearLayout ?: LinearLayout(this@LinkedBrowserActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(16), dp(10), dp(16), dp(10))
                minimumHeight = dp(60)
                val icon = TextView(context).apply { textSize = 24f; gravity = Gravity.CENTER; tag = "icon" }
                addView(icon, LinearLayout.LayoutParams(dp(40), ViewGroup.LayoutParams.WRAP_CONTENT))
                val col = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
                col.addView(TextView(context).apply {
                    tag = "name"; textSize = 16f; setTextColor(TEXT); maxLines = 1; ellipsize = TextUtils.TruncateAt.MIDDLE
                })
                col.addView(TextView(context).apply { tag = "sub"; textSize = 12f; setTextColor(MUTED); maxLines = 1 })
                addView(col, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { leftMargin = dp(8) })
                addView(TextView(context).apply { tag = "chev"; text = "\u203A"; textSize = 22f; setTextColor(MUTED) })
            }
            val entry = entries[position]
            val atRoot = DavBrowse.isRoot(path)
            row.findViewWithTag<TextView>("icon").text = DavBrowse.icon(entry, atRoot)
            row.findViewWithTag<TextView>("name").text = entry.name
            val sub = row.findViewWithTag<TextView>("sub")
            val subtitle = if (atRoot) "Drive" else DavBrowse.subtitle(entry)
            sub.text = subtitle
            sub.visibility = if (subtitle.isEmpty()) View.GONE else View.VISIBLE
            row.findViewWithTag<TextView>("chev").visibility = if (entry.isDir) View.VISIBLE else View.GONE
            return row
        }
    }

    /** Pull down from the top of the list to refresh. */
    private class PullRefresh(
        context: Context,
        private val target: () -> View,
        private val onRefresh: () -> Unit,
    ) : FrameLayout(context) {
        private val slop = ViewConfiguration.get(context).scaledTouchSlop
        private val threshold = 96 * resources.displayMetrics.density
        private var startY = 0f
        private var pulling = false

        override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> { startY = ev.y; pulling = false }
                MotionEvent.ACTION_MOVE -> {
                    if (!pulling && ev.y - startY > slop && !target().canScrollVertically(-1)) pulling = true
                }
            }
            return pulling
        }

        override fun onTouchEvent(ev: MotionEvent): Boolean {
            when (ev.actionMasked) {
                MotionEvent.ACTION_MOVE -> if (pulling) target().translationY = ((ev.y - startY) / 2).coerceIn(0f, threshold)
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    val shouldRefresh = pulling && ev.actionMasked == MotionEvent.ACTION_UP && (ev.y - startY) / 2 >= threshold * 0.6f
                    pulling = false
                    target().animate().translationY(0f).setDuration(150).start()
                    if (shouldRefresh) onRefresh()
                }
            }
            return true
        }
    }

    private fun updateChrome() {
        titleView.text = if (DavBrowse.isRoot(path)) machineName else DavBrowse.nameOf(path)
        crumbRow.removeAllViews()
        val crumbs = DavBrowse.breadcrumbs(path, machineName)
        crumbs.forEachIndexed { index, crumb ->
            val last = index == crumbs.lastIndex
            if (index > 0) crumbRow.addView(TextView(this).apply {
                text = "\u203A"; setTextColor(MUTED); textSize = 16f; setPadding(dp(4), 0, dp(4), 0)
            })
            crumbRow.addView(TextView(this).apply {
                text = crumb.label
                textSize = 14f
                maxLines = 1
                setTextColor(if (last) TEXT else ACCENT)
                if (last) setTypeface(typeface, Typeface.BOLD)
                setPadding(dp(4), dp(8), dp(4), dp(8))
                if (!last) setOnClickListener { load(crumb.path) }
            })
        }
        crumbScroll.post { crumbScroll.fullScroll(View.FOCUS_RIGHT) }
        uploadBtn.visibility = if (canWrite("upload")) View.VISIBLE else View.GONE
        folderBtn.visibility = if (canWrite("mkdir")) View.VISIBLE else View.GONE
        (list.adapter as BaseAdapter).notifyDataSetChanged()
    }

    // ---- Write permission, learned from the host ----

    private fun blockedSet(): MutableSet<String> = blocked.getOrPut(machineId) { ConcurrentHashMap.newKeySet() }

    /** Writes are never offered at the drive list. After that, only what the host has not refused. */
    private fun canWrite(action: String): Boolean {
        if (DavBrowse.isRoot(path)) return false
        val drive = DavBrowse.driveOf(path).orEmpty()
        val set = blockedSet()
        return "ro:$drive" !in set && action !in set
    }

    private fun learnRefusal(action: String, message: String) {
        val drive = DavBrowse.driveOf(path).orEmpty()
        if (message.contains("read-only", ignoreCase = true)) blockedSet().add("ro:$drive") else blockedSet().add(action)
        updateChrome()
    }

    // ---- Helpers ----

    private fun ui(block: () -> Unit) = runOnUiThread { if (!isFinishing && !isDestroyed) block() }

    private fun bg(name: String, onError: (Throwable) -> Unit = {}, block: () -> Unit) {
        thread(name = name) {
            try {
                block()
            } catch (err: Throwable) {
                ui {
                    onError(err)
                    toast("Something went wrong: " + (err.message ?: err.javaClass.simpleName))
                }
            }
        }
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    /** One place for a failed call. A 401 means the grant is gone, so forget it and leave. */
    private fun failed(status: Int?, message: String, action: String? = null) {
        if (status == 401) {
            runCatching {
                CredentialVault(this).forget("link-$machineId")
                CredentialVault(this).forget("link-scope-$machineId")
                CredentialVault(this).forget("link-url-$machineId")
            }
            toast(message)
            finish()
            return
        }
        if (action != null && DavBrowse.isRefusal(status)) learnRefusal(action, message)
        toast(message)
    }

    // ---- Navigation ----

    private fun goUp() {
        val up = DavBrowse.parent(path)
        if (up == null) finish() else load(up)
    }

    private fun refresh() = load(path)

    private fun load(target: String) {
        val dav = session ?: return
        val mine = ++generation
        loadingBar.visibility = View.VISIBLE
        bg("browse-list", onError = { if (mine == generation) loadingBar.visibility = View.INVISIBLE }) {
            val result = dav.list(target)
            ui {
                if (mine != generation) return@ui
                loadingBar.visibility = View.INVISIBLE
                when (result) {
                    is DavSession.Listing.Ok -> {
                        path = DavBrowse.folderPath(target)
                        entries = result.entries
                        status.visibility = if (entries.isEmpty()) View.VISIBLE else View.GONE
                        status.text = if (DavBrowse.isRoot(path)) "No drives are shared with this phone." else "This folder is empty."
                        updateChrome()
                        list.setSelection(0)
                    }
                    is DavSession.Listing.Fail -> {
                        if (entries.isEmpty()) {
                            status.visibility = View.VISIBLE
                            status.text = result.message + "\n\nPull down to try again."
                        }
                        failed(result.status, result.message)
                    }
                }
            }
        }
    }

    private fun onTap(entry: DavBrowse.Entry) {
        if (entry.isDir) load(entry.path) else download(entry, Mode.OPEN)
    }

    private fun onLongPress(entry: DavBrowse.Entry) {
        val actions = mutableListOf<Pair<String, () -> Unit>>()
        if (entry.isDir) {
            actions.add("Open" to { load(entry.path) })
        } else {
            actions.add("Download" to { download(entry, Mode.SAVE) })
            actions.add("Share" to { download(entry, Mode.SHARE) })
        }
        if (canWrite("rename") && !DavBrowse.isRoot(path)) actions.add("Rename" to { rename(entry) })
        if (canWrite("delete") && !DavBrowse.isRoot(path)) actions.add("Delete" to { confirmDelete(entry) })
        if (canWrite("mkdir")) actions.add("New folder" to { newFolder() })
        AlertDialog.Builder(this)
            .setTitle(entry.name)
            .setItems(actions.map { it.first }.toTypedArray()) { _, which -> actions[which].second() }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    // ---- Progress dialog ----

    private inner class Progress(title: String, onCancel: () -> Unit) {
        private val label = TextView(this@LinkedBrowserActivity).apply { text = "Starting\u2026"; textSize = 14f }
        private val bar = ProgressBar(this@LinkedBrowserActivity, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true
            max = 1000
        }
        private val dialog: AlertDialog

        init {
            val box = LinearLayout(this@LinkedBrowserActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(24), dp(16), dp(24), 0)
                addView(label)
                addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) })
            }
            dialog = AlertDialog.Builder(this@LinkedBrowserActivity)
                .setTitle(title)
                .setView(box)
                .setCancelable(false)
                .setNegativeButton(android.R.string.cancel) { _, _ -> onCancel() }
                .show()
        }

        fun update(done: Long, total: Long) {
            if (total > 0) {
                bar.isIndeterminate = false
                bar.progress = ((done * 1000) / total).toInt().coerceIn(0, 1000)
                label.text = DavBrowse.formatSize(done) + " of " + DavBrowse.formatSize(total)
            } else {
                label.text = DavBrowse.formatSize(done)
            }
        }

        fun dismiss() {
            runCatching { dialog.dismiss() }
        }
    }

    // ---- Download, open, share ----

    private fun download(entry: DavBrowse.Entry, mode: Mode) {
        val dav = session ?: return
        val cancel = AtomicBoolean(false)
        val progress = Progress("Downloading " + entry.name) { cancel.set(true) }
        bg("browse-download", onError = { progress.dismiss() }) {
            val dir = File(cacheDir, "browse").apply { mkdirs() }
            val temp = File(dir, "dl-" + System.nanoTime() + ".part")
            val result = DavTransfer.download(
                dav.url(entry.path),
                dav.auth(),
                temp,
                { done, total -> ui { progress.update(done, total) } },
                { cancel.get() },
            )
            if (!result.ok) {
                temp.delete()
                ui {
                    progress.dismiss()
                    if (!result.cancelled) failed(result.status, DavBrowse.errorMessage(result.status, result.message, "download it"))
                }
                return@bg
            }
            val mime = DownloadOpen.mimeFromName(entry.name)
            val uri: Uri = if (mode == Mode.SHARE) {
                val open = File(cacheDir, "open").apply { mkdirs() }
                val dest = File(open, DownloadOpen.cacheFileName(entry.name, entry.path + System.nanoTime()))
                temp.copyTo(dest, overwrite = true)
                temp.delete()
                FileProvider.getUriForFile(this, DownloadOpen.authority(packageName), dest)
            } else {
                try {
                    MediaStoreSaver.save(this, temp, entry.name, mime)
                } finally {
                    temp.delete()
                }
            }
            ui {
                progress.dismiss()
                if (mode == Mode.SAVE) {
                    toast("Saved to Downloads/Drivebay: " + entry.name)
                } else {
                    startActivity(Intent(this, DownloadOpenActivity::class.java).also {
                        DownloadOpenActivity.fill(it, uri, mime, entry.name, share = mode == Mode.SHARE)
                    })
                }
            }
        }
    }

    // ---- Upload ----

    private fun upload(uris: List<Uri>) {
        val dav = session ?: return
        if (!canWrite("upload")) {
            toast("Open a folder on a drive first. You cannot upload at the drive list.")
            return
        }
        val folder = path
        val taken = entries.map { it.name }.toMutableSet()
        val cancel = AtomicBoolean(false)
        val progress = Progress("Uploading", { cancel.set(true) })
        bg("browse-upload", onError = { progress.dismiss() }) {
            var sent = 0
            var problem: DavTransfer.Result? = null
            for ((index, uri) in uris.withIndex()) {
                if (cancel.get()) break
                val (rawName, length) = describe(uri)
                val name = DavBrowse.uniqueName(DownloadNames.safeFileName(rawName), taken)
                taken.add(name)
                ui { progress.update(0, length) }
                val result = contentResolver.openInputStream(uri)?.use { input ->
                    DavTransfer.upload(
                        dav.url(DavBrowse.child(folder, name, false)),
                        dav.auth(),
                        input,
                        length,
                        { done, total -> ui { progress.update(done, total) } },
                        { cancel.get() },
                    )
                } ?: DavTransfer.Result(0, "This phone could not read that file.")
                if (!result.ok) {
                    if (!result.cancelled) problem = result
                    break
                }
                sent++
                ui { if (index < uris.lastIndex) progress.update(0, -1) }
            }
            ui {
                progress.dismiss()
                val bad = problem
                if (bad != null) {
                    failed(bad.status, DavBrowse.errorMessage(bad.status, bad.message, "upload it"), "upload")
                } else if (sent > 0) {
                    toast(if (sent == 1) "Uploaded 1 file." else "Uploaded $sent files.")
                }
                if (sent > 0 && folder == path) load(folder)
            }
        }
    }

    private fun describe(uri: Uri): Pair<String, Long> {
        var name = uri.lastPathSegment?.substringAfterLast('/') ?: "upload"
        var size = -1L
        runCatching {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    c.getString(0)?.takeIf { it.isNotBlank() }?.let { name = it }
                    if (!c.isNull(1)) size = c.getLong(1)
                }
            }
        }
        return name to size
    }

    // ---- New folder, rename, delete ----

    private fun askName(title: String, initial: String, confirm: String, done: (String) -> Unit) {
        val input = EditText(this).apply {
            setText(initial)
            setSelection(initial.length)
            inputType = InputType.TYPE_CLASS_TEXT
            setSingleLine()
        }
        val holder = FrameLayout(this).apply {
            setPadding(dp(20), dp(8), dp(20), 0)
            addView(input)
        }
        AlertDialog.Builder(this)
            .setTitle(title)
            .setView(holder)
            .setPositiveButton(confirm) { _, _ ->
                val name = input.text?.toString()?.trim().orEmpty()
                val problem = DavBrowse.nameProblem(name)
                if (problem != null) toast(problem) else done(name)
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun newFolder() {
        val dav = session ?: return
        if (!canWrite("mkdir")) return
        val folder = path
        askName("New folder", "", "Create") { name ->
            if (entries.any { it.name == name }) {
                toast("\u201C$name\u201D already exists here.")
                return@askName
            }
            bg("browse-mkdir") {
                val op = dav.makeFolder(DavBrowse.child(folder, name, true))
                ui {
                    if (op.ok) {
                        if (folder == path) load(folder)
                    } else {
                        failed(op.status, op.message, "mkdir")
                    }
                }
            }
        }
    }

    private fun rename(entry: DavBrowse.Entry) {
        val dav = session ?: return
        val folder = DavBrowse.parent(entry.path) ?: return
        askName("Rename", entry.name, "Rename") { name ->
            if (name == entry.name) return@askName
            if (entries.any { it.name == name }) {
                toast("\u201C$name\u201D already exists here.")
                return@askName
            }
            bg("browse-rename") {
                val op = dav.move(entry.path, DavBrowse.child(folder, name, entry.isDir), entry.isDir)
                ui {
                    if (op.ok) load(path) else failed(op.status, op.message, "rename")
                }
            }
        }
    }

    private fun confirmDelete(entry: DavBrowse.Entry) {
        val dav = session ?: return
        val what = if (entry.isDir) "the folder \u201C${entry.name}\u201D and everything in it" else "\u201C${entry.name}\u201D"
        AlertDialog.Builder(this)
            .setTitle("Delete?")
            .setMessage("This deletes $what from ${machineName}. It cannot be undone.")
            .setPositiveButton("Delete") { _, _ ->
                bg("browse-delete") {
                    val op = dav.delete(entry.path, entry.isDir)
                    ui {
                        if (op.ok) load(path) else failed(op.status, op.message, "delete")
                    }
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    companion object {
        const val EXTRA_MACHINE_ID = "machineId"
        const val EXTRA_NAME = "name"
        const val EXTRA_URL = "url"

        private val BG = Color.parseColor("#0F1218")
        private val SURFACE = Color.parseColor("#161B24")
        private val TEXT = Color.parseColor("#E8EEF7")
        private val MUTED = Color.parseColor("#94A3B8")
        private val ACCENT = Color.parseColor("#7DD3FC")
        private val DIVIDER = Color.parseColor("#1E293B")

        /** What each machine's host has refused so far, kept until the app closes. */
        private val blocked = ConcurrentHashMap<String, MutableSet<String>>()

        fun launch(context: Context, machine: JSONObject) {
            val url = MesaCloud.connectionUrl(machine)
            context.startActivity(
                Intent(context, LinkedBrowserActivity::class.java)
                    .putExtra(EXTRA_MACHINE_ID, machine.optString("machineId"))
                    .putExtra(EXTRA_NAME, machine.optString("displayName"))
                    .putExtra(EXTRA_URL, url),
            )
        }
    }
}
