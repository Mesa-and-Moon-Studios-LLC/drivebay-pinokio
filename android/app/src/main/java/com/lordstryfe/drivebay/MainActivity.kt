package com.lordstryfe.drivebay

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.provider.OpenableColumns
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import androidx.activity.result.contract.ActivityResultContracts
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.material.button.MaterialButton
import com.mesaandmoon.update.AppUpdateGate
import com.google.android.material.floatingactionbutton.FloatingActionButton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var setupPanel: View
    private lateinit var tailscalePanel: LinearLayout
    private lateinit var urlInput: EditText
    private lateinit var connectBtn: MaterialButton
    private lateinit var settingsFab: FloatingActionButton
    private lateinit var wifiOnlyLarge: CheckBox
    private lateinit var rememberLogin: CheckBox
    private lateinit var serverNameInput: EditText
    private lateinit var serversList: LinearLayout
    private lateinit var serversLabel: TextView
    private lateinit var serversHint: TextView
    private lateinit var downloadsBtn: MaterialButton
    private lateinit var downloadsFab: FloatingActionButton

    private val prefs by lazy { getSharedPreferences(PREFS, Context.MODE_PRIVATE) }
    private val servers by lazy { ServerStore(this) }
    private val downloadsList by lazy { DownloadsList(this) { refreshDownloadsSoon() } }
    private var currentServer: SavedServer? = null
    /** Username/password typed on the Drivebay sign-in page, saved once the page moves past /login. */
    private var pendingLogin: Pair<String, String>? = null
    /** Servers whose saved login was already auto-submitted this session (fill only after that, never loop). */
    private val autoSubmitted = mutableSetOf<String>()
    private var downloadsAttention = 0
    private var settingRemember = false

    private fun setRememberChecked(value: Boolean) {
        settingRemember = true
        rememberLogin.isChecked = value
        settingRemember = false
    }
    private var pendingDownload: PendingDownload? = null
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var uploadParent: String? = null
    private lateinit var shareBanner: TextView
    private lateinit var phoneShareBox: LinearLayout
    private val phoneShare by lazy { PhoneShareStore(this) }
    private var updatingShare = false

    private val uploadLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val parent = uploadParent
            uploadParent = null
            val uris = chosenUris(result.resultCode, result.data)
            if (parent.isNullOrBlank() || uris.isNullOrEmpty()) {
                Toast.makeText(this, R.string.upload_failed, Toast.LENGTH_SHORT).show()
                return@registerForActivityResult
            }
            Toast.makeText(this, R.string.upload_started, Toast.LENGTH_SHORT).show()
            lifecycleScope.launch {
                val page = webView.url.orEmpty()
                val cookie = CookieManager.getInstance().getCookie(page).orEmpty()
                val agent = webView.settings.userAgentString.orEmpty()
                var uploaded = 0
                var failed = 0
                withContext(Dispatchers.IO) {
                    uris.forEach { uri ->
                        val name = displayName(uri)
                        val target = UploadPicker.rawUploadUrl(page, parent, name)
                        val stream = if (target == null) null else contentResolver.openInputStream(uri)
                        val code = if (target == null || stream == null) -1 else stream.use {
                            PhoneUpload.post(target, cookie, it, displaySize(uri), agent)
                        }
                        if (code in 200..299) uploaded += 1 else failed += 1
                    }
                }
                val message = if (failed == 0 && uploaded > 0) getString(R.string.upload_done) else getString(R.string.upload_failed)
                Toast.makeText(this@MainActivity, message, Toast.LENGTH_LONG).show()
                if (uploaded > 0) {
                    webView.evaluateJavascript("window.__drivebayUploadFinished && window.__drivebayUploadFinished()", null)
                }
            }
        }

    // Registered at construction time (before onCreate) as ActivityResult requires.
    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val cb = fileChooserCallback
            fileChooserCallback = null
            if (cb == null) return@registerForActivityResult
            val data = result.data
            val uris: Array<Uri>? = if (result.resultCode == RESULT_OK && data != null) {
                val clip = data.clipData
                when {
                    clip != null && clip.itemCount > 0 -> Array(clip.itemCount) { clip.getItemAt(it).uri }
                    data.data != null -> arrayOf(data.data!!)
                    else -> null
                }
            } else null
            // WebView cannot read another app's content URI. Copy into our cache and hand it a file URI.
            val local = uris?.mapIndexed { index, uri -> copyForWebView(uri, index) }?.toTypedArray()
            cb.onReceiveValue(local)
        }

    private val finishedReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == DrivebayDownloadService.ACTION_JOBS_CHANGED) {
                refreshDownloadsUi()
                return
            }
            if (intent?.action == PhoneShareService.ACTION_STATE) {
                renderPhoneShare(intent.getStringExtra(PhoneShareService.EXTRA_HOSTS))
                return
            }
            if (intent?.action != DrivebayDownloadService.ACTION_FINISHED) return
            val name = intent.getStringExtra(DrivebayDownloadService.EXTRA_NAME) ?: return
            val uri = intent.getStringExtra(DrivebayDownloadService.EXTRA_URI)?.let(Uri::parse) ?: return
            val mime = intent.getStringExtra(DrivebayDownloadService.EXTRA_MIME) ?: "application/octet-stream"
            if (lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) {
                offerOpenShare(name, uri, mime)
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        // Android 15+ (targetSdk 35+) always draws edge-to-edge. Opt in the supported way with dark
        // bars, and pad the root by the system-bar, cutout, and keyboard insets below.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)

        setContentView(R.layout.activity_main)
        // Required/optional Play update check, controlled by version.json (see mm-update-check README).
        AppUpdateGate.attach(this, UPDATE_CONFIG_URL)
        webView = findViewById(R.id.webView)
        setupPanel = findViewById(R.id.setupPanel)
        tailscalePanel = findViewById(R.id.tailscalePanel)
        urlInput = findViewById(R.id.urlInput)
        connectBtn = findViewById(R.id.connectBtn)
        settingsFab = findViewById(R.id.settingsFab)
        wifiOnlyLarge = findViewById(R.id.wifiOnlyLarge)
        rememberLogin = findViewById(R.id.rememberLogin)
        serverNameInput = findViewById(R.id.serverNameInput)
        serversList = findViewById(R.id.serversList)
        serversLabel = findViewById(R.id.serversLabel)
        serversHint = findViewById(R.id.serversHint)
        downloadsBtn = findViewById(R.id.downloadsBtn)
        downloadsFab = findViewById(R.id.downloadsFab)
        shareBanner = findViewById(R.id.shareBanner)
        phoneShareBox = findViewById(R.id.phoneShareBox)
        renderPhoneShare()
        migrateSingleServer()
        wifiOnlyLarge.isChecked = prefs.getBoolean(KEY_WIFI_ONLY, false)
        wifiOnlyLarge.setOnCheckedChangeListener { _, checked ->
            prefs.edit().putBoolean(KEY_WIFI_ONLY, checked).apply()
        }

        webView.setBackgroundColor(0xFF0F1218.toInt())
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true

        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        cookies.setAcceptThirdPartyCookies(webView, true)
        webView.addJavascriptInterface(DrivebayJs(), "DrivebayNative")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val target = request?.url ?: return false
                val url = target.toString()
                if (ServerAddress.isAdminSettingsUrl(url)) {
                    showSetup(keepUrl = true)
                    return true
                }
                if (looksLikeDownload(url)) {
                    beginDownload(url, null, null)
                    return true
                }
                view?.loadUrl(url)
                return true
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                if (url != null && ServerAddress.isAdminSettingsUrl(url)) {
                    view?.stopLoading()
                    showSetup(keepUrl = true)
                    return
                }
                super.onPageStarted(view, url, favicon)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                view?.evaluateJavascript(PAGE_HOOK, null)
                onServerUrlChanged(url)
            }

            // The Drivebay UI is a single-page app: sign-in -> file browser is a pushState, not a page load.
            override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) {
                super.doUpdateVisitedHistory(view, url, isReload)
                onServerUrlChanged(url)
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            // Without this override, <input type="file"> in the WebView silently does nothing.
            override fun onShowFileChooser(
                view: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?,
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback
                val accept = UploadPicker.mimeTypes(fileChooserParams?.acceptTypes)
                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = if (accept.size == 1) accept[0] else "*/*"
                    if (accept.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, accept.toTypedArray())
                    if (fileChooserParams?.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                }
                return try {
                    fileChooserLauncher.launch(Intent.createChooser(intent, "Choose files to upload"))
                    true
                } catch (e: Exception) {
                    fileChooserCallback = null
                    filePathCallback?.onReceiveValue(null)
                    false
                }
            }
        }
        webView.setDownloadListener { url, _, contentDisposition, mimeType, _ ->
            if (url.startsWith("blob:") || url.startsWith("data:")) return@setDownloadListener
            val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
            beginDownload(url, name, null)
        }

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        // File chooser results are copied into the app cache. WebView has to be allowed to read those.
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.setSupportZoom(false)
        settings.mediaPlaybackRequiresUserGesture = false
        settings.userAgentString = settings.userAgentString + " DriveBayAndroid/" + BuildConfig.VERSION_NAME

        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.root)) { v, insets ->
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(sys.left, sys.top, sys.right, maxOf(ime.bottom, sys.bottom))
            WindowInsetsCompat.CONSUMED
        }

        connectBtn.setOnClickListener { saveAndConnect() }
        settingsFab.setOnClickListener { showSetup(keepUrl = true) }
        downloadsBtn.setOnClickListener { downloadsList.show() }
        downloadsFab.setOnClickListener { downloadsList.show() }
        rememberLogin.setOnCheckedChangeListener { _, checked ->
            if (settingRemember) return@setOnCheckedChangeListener
            val server = currentServer?.let { servers.find(it.url) } ?: return@setOnCheckedChangeListener
            val next = server.copy(rememberLogin = checked)
            servers.update(next)
            if (!checked) servers.forgetLogin(next)
            currentServer = servers.find(next.url)
            renderServers()
        }
        findViewById<MaterialButton>(R.id.tailscaleDownloadBtn).setOnClickListener { openTailscaleStore() }
        findViewById<MaterialButton>(R.id.tailscaleSkipBtn).setOnClickListener {
            prefs.edit().putBoolean(KEY_TAILSCALE_SKIP, true).apply()
            continueAfterTailscale()
        }

        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    when {
                        tailscalePanel.visibility == View.VISIBLE -> finish()
                        setupPanel.visibility == View.VISIBLE && !prefs.getString(KEY_URL, null).isNullOrBlank() -> {
                            connectTo(prefs.getString(KEY_URL, null)!!)
                        }
                        webView.visibility == View.VISIBLE -> webView.evaluateJavascript(BACK_JS) { raw ->
                            when (raw) {
                                "1" -> Unit
                                "0" -> finish()
                                else -> if (webView.canGoBack()) webView.goBack() else finish()
                            }
                        }
                        else -> finish()
                    }
                }
            },
        )

        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS)
        }

        if (!isTailscaleInstalled() && !prefs.getBoolean(KEY_TAILSCALE_SKIP, false)) {
            showTailscale()
        } else {
            continueAfterTailscale(savedInstanceState)
        }
    }

    override fun onStart() {
        super.onStart()
        ContextCompat.registerReceiver(
            this,
            finishedReceiver,
            IntentFilter(DrivebayDownloadService.ACTION_FINISHED).apply {
                addAction(DrivebayDownloadService.ACTION_JOBS_CHANGED)
                addAction(PhoneShareService.ACTION_STATE)
            },
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        DrivebayDownloadService.resumeIncomplete(this)
        refreshDownloadsUi()
        if (phoneShare.enabled()) PhoneShareService.start(this)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        if (tailscalePanel.visibility == View.VISIBLE && isTailscaleInstalled()) {
            continueAfterTailscale()
        }
    }

    override fun onPause() {
        webView.onPause()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onStop() {
        unregisterReceiver(finishedReceiver)
        super.onStop()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (webView.visibility == View.VISIBLE) webView.saveState(outState)
    }

    override fun onDestroy() {
        (webView.parent as? android.view.ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_STORAGE) return
        val pending = pendingDownload
        pendingDownload = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED && pending != null) {
            enqueue(pending)
        } else if (pending != null) {
            Toast.makeText(this, "Allow storage access to save into Downloads/Drivebay", Toast.LENGTH_LONG).show()
        }
    }

    private fun isTailscaleInstalled(): Boolean {
        return try {
            packageManager.getPackageInfo(TAILSCALE_PACKAGE, 0)
            true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }
    }

    private fun openTailscaleStore() {
        val market = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$TAILSCALE_PACKAGE"))
        try {
            startActivity(market)
        } catch (_: ActivityNotFoundException) {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$TAILSCALE_PACKAGE")))
        }
    }

    private fun continueAfterTailscale(savedInstanceState: Bundle? = null) {
        val saved = prefs.getString(KEY_URL, null)?.trim().orEmpty()
        if (saved.isEmpty()) {
            showSetup(keepUrl = false)
            return
        }
        urlInput.setText(saved)
        currentServer = servers.find(saved)
        if (savedInstanceState != null && !shouldPromptLegacy(saved)) {
            webView.restoreState(savedInstanceState)
            showBrowser()
            return
        }
        if (shouldPromptLegacy(saved)) {
            showSetup(keepUrl = true)
            promptLegacyPort(saved, fromStartup = true)
            return
        }
        connectTo(saved)
    }

    private fun saveAndConnect() {
        val raw = urlInput.text?.toString()?.trim().orEmpty()
        if (raw.isEmpty()) {
            Toast.makeText(this, R.string.missing_url, Toast.LENGTH_SHORT).show()
            return
        }
        val normalized = ServerAddress.normalize(raw)
        urlInput.setText(normalized)
        // Typing a different address while a saved server's name is in the box means "new server".
        val typedName = serverNameInput.text?.toString()?.trim().orEmpty()
        val sameServer = currentServer?.let { ServerProfiles.keyOf(it.url) == ServerProfiles.keyOf(normalized) } == true
        pendingName = typedName.takeIf { it.isNotEmpty() && (sameServer || typedName != currentServer?.name) }
        pendingRemember = rememberLogin.isChecked
        if (shouldPromptLegacy(normalized)) {
            promptLegacyPort(normalized, fromStartup = false)
            return
        }
        persistAndConnect(normalized)
    }

    private fun shouldPromptLegacy(url: String): Boolean {
        val port = ServerAddress.portOf(url) ?: return false
        if (!ServerAddress.isLegacyPort(port)) return false
        return prefs.getString(KEY_LEGACY_ACK, null) != url
    }

    private fun promptLegacyPort(url: String, fromStartup: Boolean) {
        val port = ServerAddress.portOf(url) ?: ServerAddress.SUGGESTED_PORT
        AlertDialog.Builder(this)
            .setTitle(R.string.legacy_port_title)
            .setMessage(getString(R.string.legacy_port_message, port))
            .setPositiveButton(R.string.legacy_port_update) { _, _ ->
                persistAndConnect(ServerAddress.withPort(url, ServerAddress.SUGGESTED_PORT))
            }
            .setNegativeButton(getString(R.string.legacy_port_keep, port)) { _, _ ->
                prefs.edit().putString(KEY_LEGACY_ACK, url).apply()
                persistAndConnect(url)
            }
            .setOnCancelListener {
                if (!fromStartup) {
                    /* Stay on the address screen so the port can be edited. */
                }
            }
            .show()
    }

    private var pendingName: String? = null
    private var pendingRemember: Boolean? = null

    private fun persistAndConnect(url: String) {
        val normalized = ServerAddress.normalize(url)
        prefs.edit().putString(KEY_URL, normalized).apply()
        urlInput.setText(normalized)
        var entry = servers.touch(normalized, pendingName)
        pendingRemember?.let { remember ->
            if (entry.rememberLogin != remember) {
                entry = entry.copy(rememberLogin = remember)
                servers.update(entry)
                if (!remember) servers.forgetLogin(entry)
            }
        }
        pendingName = null
        pendingRemember = null
        connectTo(normalized)
    }

    private fun connectTo(url: String) {
        val previous = currentServer
        currentServer = servers.find(url) ?: servers.touch(url, null)
        if (previous != null && previous.id != currentServer?.id) {
            pendingLogin = null
            // A different PC: start from a clean page instead of the old server's history.
            webView.clearHistory()
        }
        showBrowser()
        webView.loadUrl(ServerAddress.homeUrl(url))
    }

    /** 3.33.3 and earlier kept one address. Carry it into the saved server list once. */
    private fun migrateSingleServer() {
        val saved = prefs.getString(KEY_URL, null)?.trim().orEmpty()
        if (saved.isNotEmpty() && servers.find(saved) == null) servers.touch(saved, null)
    }

    private fun switchTo(server: SavedServer) {
        urlInput.setText(server.url)
        serverNameInput.setText(server.name)
        setRememberChecked(server.rememberLogin)
        pendingName = null
        pendingRemember = null
        if (shouldPromptLegacy(server.url)) {
            promptLegacyPort(server.url, fromStartup = false)
            return
        }
        persistAndConnect(server.url)
    }

    private fun renderServers() {
        val list = servers.all()
        val activeKey = prefs.getString(KEY_URL, null)?.let(ServerProfiles::keyOf)
        serversList.removeAllViews()
        serversLabel.visibility = if (list.isEmpty()) View.GONE else View.VISIBLE
        serversHint.visibility = if (list.isEmpty()) View.GONE else View.VISIBLE
        val density = resources.displayMetrics.density
        list.forEach { server ->
            val isActive = ServerProfiles.keyOf(server.url) == activeKey
            val tags = buildList {
                if (isActive) add(getString(R.string.server_current))
                if (server.rememberLogin && servers.vault.has(server.id)) add(getString(R.string.server_login_saved_tag))
            }
            val second = server.url + if (tags.isEmpty()) "" else " · " + tags.joinToString(" · ")
            val button = MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                text = "${server.name}\n$second"
                isAllCaps = false
                textAlignment = View.TEXT_ALIGNMENT_VIEW_START
                setTextColor(if (isActive) 0xFF7DD3FC.toInt() else 0xFFE8EEF7.toInt())
                setOnClickListener { switchTo(server) }
                setOnLongClickListener {
                    showServerOptions(server)
                    true
                }
            }
            serversList.addView(
                button,
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                    topMargin = (6 * density).toInt()
                },
            )
        }
    }

    private fun showServerOptions(server: SavedServer) {
        val hasLogin = servers.vault.has(server.id)
        val options = buildList {
            add(getString(R.string.server_rename) to { renameServer(server) })
            if (hasLogin) {
                add(
                    getString(R.string.server_forget_login) to {
                        servers.forgetLogin(server)
                        renderServers()
                    },
                )
            }
            add(getString(R.string.server_remove) to { confirmRemoveServer(server) })
        }
        AlertDialog.Builder(this)
            .setTitle(server.name)
            .setItems(options.map { it.first }.toTypedArray()) { _, which -> options[which].second() }
            .show()
    }

    private fun renameServer(server: SavedServer) {
        val input = EditText(this).apply {
            setText(server.name)
            setSelection(text.length)
            isSingleLine = true
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.server_rename)
            .setView(input)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                val name = input.text?.toString()?.trim().orEmpty()
                if (name.isNotEmpty()) {
                    servers.update(server.copy(name = name.take(40)))
                    if (currentServer?.id == server.id) serverNameInput.setText(name.take(40))
                    renderServers()
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun confirmRemoveServer(server: SavedServer) {
        AlertDialog.Builder(this)
            .setMessage(getString(R.string.server_remove_confirm, server.name))
            .setPositiveButton(R.string.server_remove) { _, _ ->
                servers.delete(server.id)
                if (currentServer?.id == server.id) currentServer = null
                renderServers()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /** Called for every page load and SPA route change in the WebView. */
    private fun onServerUrlChanged(url: String?) {
        val server = currentServer ?: return
        if (url.isNullOrBlank() || ServerProfiles.keyOf(url) != ServerProfiles.keyOf(server.url)) return
        if (ServerProfiles.isLoginUrl(url)) {
            webView.evaluateJavascript(LOGIN_HOOK, null)
            val fresh = servers.find(server.url) ?: server
            val user = fresh.username
            val password = if (fresh.rememberLogin) servers.vault.load(fresh.id) else null
            if (!user.isNullOrBlank() && !password.isNullOrEmpty()) {
                // Auto sign-in at most once per server per app session; afterwards only pre-fill,
                // so a stale saved password can never loop.
                val submit = fresh.id !in autoSubmitted
                webView.evaluateJavascript(
                    "window.__drivebayFillLogin && window.__drivebayFillLogin(" +
                        ServerProfiles.jsString(user) + "," + ServerProfiles.jsString(password) + "," + submit + ")",
                    null,
                )
            }
            return
        }
        val login = pendingLogin ?: return
        pendingLogin = null
        val fresh = servers.find(server.url) ?: return
        // Signed in. A working login also allows one auto sign-in again later this session.
        autoSubmitted.remove(fresh.id)
        if (!fresh.rememberLogin) return
        val changed = fresh.username != login.first || servers.vault.load(fresh.id) != login.second
        servers.saveLogin(fresh, login.first, login.second)
        currentServer = servers.find(fresh.url)
        if (changed) Toast.makeText(this, getString(R.string.login_saved, fresh.name), Toast.LENGTH_SHORT).show()
    }

    private fun refreshDownloadsSoon() {
        webView.postDelayed({ refreshDownloadsUi() }, 400)
    }

    private fun refreshDownloadsUi() {
        lifecycleScope.launch {
            val jobs = withContext(Dispatchers.IO) { downloadsList.jobs() }
            downloadsAttention = DownloadsOrder.needsAttention(jobs)
            downloadsBtn.text = if (jobs.isEmpty()) getString(R.string.downloads) else getString(R.string.downloads_count, jobs.size)
            downloadsFab.visibility = if (webView.visibility == View.VISIBLE && downloadsAttention > 0) View.VISIBLE else View.GONE
            shareBanner.visibility = if (webView.visibility == View.VISIBLE && phoneShare.enabled()) View.VISIBLE else View.GONE
        }
    }

    private fun showBrowser() {
        tailscalePanel.visibility = View.GONE
        setupPanel.visibility = View.GONE
        webView.visibility = View.VISIBLE
        settingsFab.visibility = View.VISIBLE
        downloadsFab.visibility = if (downloadsAttention > 0) View.VISIBLE else View.GONE
        shareBanner.visibility = if (phoneShare.enabled()) View.VISIBLE else View.GONE
    }

    private fun showSetup(keepUrl: Boolean) {
        if (!keepUrl) urlInput.setText("")
        else if (urlInput.text.isNullOrBlank()) {
            urlInput.setText(prefs.getString(KEY_URL, "") ?: "")
        }
        val active = prefs.getString(KEY_URL, null)?.let { servers.find(it) }
        serverNameInput.setText(active?.name.orEmpty())
        setRememberChecked(active?.rememberLogin ?: true)
        renderServers()
        refreshDownloadsUi()
        tailscalePanel.visibility = View.GONE
        webView.visibility = View.GONE
        settingsFab.visibility = View.GONE
        downloadsFab.visibility = View.GONE
        shareBanner.visibility = View.GONE
        setupPanel.visibility = View.VISIBLE
    }

    private fun showTailscale() {
        webView.visibility = View.GONE
        setupPanel.visibility = View.GONE
        settingsFab.visibility = View.GONE
        downloadsFab.visibility = View.GONE
        shareBanner.visibility = View.GONE
        tailscalePanel.visibility = View.VISIBLE
    }

    private val folderLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val uri = result.data?.data
            if (result.resultCode != RESULT_OK || uri == null) return@registerForActivityResult
            val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            try {
                contentResolver.takePersistableUriPermission(uri, flags)
            } catch (_: Exception) {
                /* The picker still grants access for this session. */
            }
            val name = DocumentName(uri)
            val next = phoneShare.folders().filterNot { it.uri == uri.toString() } + SharedFolder(uri.toString(), name)
            phoneShare.setFolders(next)
            renderPhoneShare()
            if (phoneShare.enabled()) PhoneShareService.start(this)
        }

    private fun renderPhoneShare(hostsCsv: String? = null) {
        phoneShareBox.removeAllViews()
        val toggle = CheckBox(this).apply {
            text = getString(R.string.phone_share_toggle)
            setTextColor(0xFFE8EEF7.toInt())
            buttonTintList = android.content.res.ColorStateList.valueOf(0xFF7DD3FC.toInt())
            isChecked = phoneShare.enabled()
            setOnCheckedChangeListener { _, checked ->
                if (updatingShare) return@setOnCheckedChangeListener
                if (checked && phoneShare.folders().isEmpty()) {
                    updatingShare = true
                    isChecked = false
                    updatingShare = false
                    Toast.makeText(this@MainActivity, R.string.phone_share_need_folder, Toast.LENGTH_LONG).show()
                    return@setOnCheckedChangeListener
                }
                if (checked && phoneShare.tokenHash() == null) {
                    updatingShare = true
                    isChecked = false
                    updatingShare = false
                    revealNewToken()
                    return@setOnCheckedChangeListener
                }
                phoneShare.setEnabled(checked)
                if (checked) PhoneShareService.start(this@MainActivity) else PhoneShareService.stop(this@MainActivity)
                renderPhoneShare()
            }
        }
        phoneShareBox.addView(toggle)
        val pick = MaterialButton(this).apply {
            text = getString(R.string.phone_share_pick)
            isAllCaps = false
            setOnClickListener {
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
                }
                try {
                    folderLauncher.launch(intent)
                } catch (_: Exception) {
                    Toast.makeText(this@MainActivity, R.string.phone_share_need_folder, Toast.LENGTH_LONG).show()
                }
            }
        }
        phoneShareBox.addView(pick)
        val token = MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            text = getString(R.string.phone_share_token)
            isAllCaps = false
            setTextColor(0xFFE8EEF7.toInt())
            setOnClickListener { revealNewToken() }
        }
        phoneShareBox.addView(token)
        phoneShare.folders().forEach { folder ->
            phoneShareBox.addView(TextView(this).apply {
                text = folder.name
                setTextColor(0xFFCBD5E1.toInt())
                textSize = 14f
                setPadding(0, 8, 0, 0)
            })
        }
        val hosts = when {
            hostsCsv != null -> hostsCsv.split(',').filter { it.isNotBlank() }
            phoneShare.enabled() -> phoneShare.listeningHosts()
            else -> emptyList()
        }
        val status = when {
            !phoneShare.enabled() -> getString(R.string.phone_share_off)
            hosts.isEmpty() -> getString(R.string.phone_share_reconnecting) + "\n" + getString(R.string.phone_share_waiting)
            else -> getString(R.string.phone_share_address, hosts.joinToString("  ") { "http://$it:${PhoneShareService.PORT}/" })
        }
        phoneShareBox.addView(TextView(this).apply {
            text = status
            setTextColor(if (phoneShare.enabled()) 0xFFBBF7D0.toInt() else 0xFF94A3B8.toInt())
            textSize = 13f
            setPadding(0, 12, 0, 0)
        })
        shareBanner.text = PhoneShareLifecycle.bannerText(
            getString(R.string.phone_share_on),
            getString(R.string.phone_share_connected),
            getString(R.string.phone_share_reconnecting),
            hosts,
            PhoneShareService.PORT,
        )
        if (webView.visibility == View.VISIBLE) {
            shareBanner.visibility = if (phoneShare.enabled()) View.VISIBLE else View.GONE
        }
    }

    private fun revealNewToken() {
        val token = PhoneShareAuth.generateToken()
        phoneShare.setTokenHash(PhoneShareAuth.hash(token))
        AlertDialog.Builder(this)
            .setTitle(R.string.phone_share_token)
            .setMessage(getString(R.string.phone_share_token_once) + "\n\n" + token)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                if (phoneShare.folders().isNotEmpty()) {
                    phoneShare.setEnabled(true)
                    PhoneShareService.start(this)
                }
                renderPhoneShare()
            }
            .show()
    }

    private fun DocumentName(uri: Uri): String {
        val queried = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
        return queried?.takeIf { it.isNotBlank() } ?: uri.lastPathSegment?.substringAfter(':')?.substringAfterLast('/') ?: "Folder"
    }

    private fun chosenUris(resultCode: Int, data: Intent?): List<Uri>? {
        if (resultCode != RESULT_OK || data == null) return null
        val clip = data.clipData
        return when {
            clip != null && clip.itemCount > 0 -> List(clip.itemCount) { clip.getItemAt(it).uri }
            data.data != null -> listOf(data.data!!)
            else -> null
        }
    }

    private fun displayName(uri: Uri): String {
        val queried = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
        return DownloadNames.safeFileName(queried ?: uri.lastPathSegment ?: "upload")
    }

    private fun displaySize(uri: Uri): Long {
        val queried = contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else -1L
        }
        return queried ?: -1L
    }

    private fun copyForWebView(uri: Uri, index: Int): Uri {
        return try {
            val dest = UploadPicker.uploadFile(cacheDir, displayName(uri), index)
            contentResolver.openInputStream(uri)?.use { input -> dest.outputStream().use { input.copyTo(it) } }
                ?: return uri
            Uri.fromFile(dest)
        } catch (_: Exception) {
            uri
        }
    }

    private fun looksLikeDownload(url: String): Boolean {
        val lower = url.lowercase()
        return lower.contains("/api/download")
    }

    private fun beginDownload(url: String, suggestedName: String?, knownSize: Long?) {
        val httpUrl = toHttpDownloadUrl(url)
        if (httpUrl.isNullOrBlank()) {
            Toast.makeText(this, R.string.download_need_http, Toast.LENGTH_LONG).show()
            return
        }
        val allowedHost = prefs.getString(KEY_URL, null)?.let(ServerAddress::hostOf)
        val targetHost = ServerAddress.hostOf(httpUrl)
        if (allowedHost.isNullOrBlank() || !allowedHost.equals(targetHost, ignoreCase = true)) {
            Toast.makeText(this, R.string.download_need_http, Toast.LENGTH_LONG).show()
            return
        }
        val name = DownloadNames.fileNameFromDownloadUrl(httpUrl, suggestedName)
        lifecycleScope.launch {
            val size = knownSize?.takeIf { it > 0L } ?: withContext(Dispatchers.IO) {
                runCatching {
                    val cookie = CookieManager.getInstance().getCookie(httpUrl).orEmpty()
                    ChunkDownloader.probe(
                        DownloadJob(
                            id = "probe",
                            url = httpUrl,
                            fileName = name,
                            cookie = cookie,
                            userAgent = webView.settings.userAgentString.orEmpty(),
                            totalBytes = -1L,
                            downloadedBytes = 0L,
                            etag = null,
                            mime = null,
                            wifiOnly = false,
                            state = DownloadJob.STATE_QUEUED,
                            error = null,
                            createdAt = 0L,
                        ),
                    ).total
                }.getOrDefault(-1L)
            }
            if (size >= DownloadPlan.LARGE_FILE_BYTES && !prefs.getBoolean(KEY_WIFI_ASKED, false)) {
                promptLargeFile(httpUrl, name, size)
            } else {
                val wifiOnly = size >= DownloadPlan.LARGE_FILE_BYTES && prefs.getBoolean(KEY_WIFI_ONLY, false)
                stageDownload(httpUrl, name, size, wifiOnly)
            }
        }
    }

    private fun promptLargeFile(url: String, name: String, size: Long) {
        AlertDialog.Builder(this)
            .setTitle(name)
            .setMessage("This file is large. Save it to Downloads/Drivebay on Wi-Fi only, or on any network?")
            .setPositiveButton("Wi-Fi only") { _, _ ->
                prefs.edit().putBoolean(KEY_WIFI_ONLY, true).putBoolean(KEY_WIFI_ASKED, true).apply()
                wifiOnlyLarge.isChecked = true
                stageDownload(url, name, size, wifiOnly = true)
            }
            .setNegativeButton("Any network") { _, _ ->
                prefs.edit().putBoolean(KEY_WIFI_ONLY, false).putBoolean(KEY_WIFI_ASKED, true).apply()
                wifiOnlyLarge.isChecked = false
                stageDownload(url, name, size, wifiOnly = false)
            }
            .setNeutralButton(android.R.string.cancel, null)
            .show()
    }

    private fun stageDownload(url: String, name: String, size: Long, wifiOnly: Boolean) {
        CookieManager.getInstance().flush()
        val cookie = CookieManager.getInstance().getCookie(url).orEmpty()
        val pending = PendingDownload(url, name, cookie, webView.settings.userAgentString.orEmpty(), size, wifiOnly)
        if (Build.VERSION.SDK_INT <= 28 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED
        ) {
            pendingDownload = pending
            requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), REQ_STORAGE)
            return
        }
        enqueue(pending)
    }

    private fun enqueue(pending: PendingDownload) {
        DrivebayDownloadService.enqueue(
            this,
            pending.url,
            pending.name,
            pending.cookie,
            pending.userAgent,
            pending.size,
            pending.wifiOnly,
        )
        Toast.makeText(this, R.string.download_started, Toast.LENGTH_SHORT).show()
    }

    private fun toHttpDownloadUrl(url: String): String? {
        val parsed = Uri.parse(url)
        val scheme = parsed.scheme?.lowercase()
        if (scheme == "http" || scheme == "https") return url
        if (scheme == "blob" || scheme == "data") return null
        val base = webView.url ?: return null
        return try {
            java.net.URL(java.net.URL(base), url).toString()
        } catch (_: Exception) {
            null
        }
    }

    private fun offerOpenShare(name: String, uri: Uri, mime: String) {
        AlertDialog.Builder(this)
            .setTitle(R.string.download_saved)
            .setMessage(name)
            .setPositiveButton(R.string.download_open) { _, _ ->
                startActivity(
                    Intent(this, DownloadOpenActivity::class.java).apply {
                        data = uri
                        type = mime
                        putExtra(DownloadOpenActivity.EXTRA_SHARE, false)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    },
                )
            }
            .setNegativeButton(R.string.download_share) { _, _ ->
                startActivity(
                    Intent(this, DownloadOpenActivity::class.java).apply {
                        data = uri
                        type = mime
                        putExtra(DownloadOpenActivity.EXTRA_SHARE, true)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    },
                )
            }
            .setNeutralButton(R.string.download_done, null)
            .show()
    }

    private inner class DrivebayJs {
        @JavascriptInterface
        fun download(url: String, fileName: String, size: String) {
            val bytes = size.toLongOrNull() ?: size.toDoubleOrNull()?.toLong() ?: -1L
            runOnUiThread { beginDownload(url, fileName, bytes.takeIf { it > 0L }) }
        }

        @JavascriptInterface
        fun openAppSettings() {
            runOnUiThread { showSetup(keepUrl = true) }
        }

        /** The sign-in form was submitted. Saved only after the page leaves /login (i.e. it worked). */
        @JavascriptInterface
        fun loginSubmitted(username: String, password: String) {
            runOnUiThread {
                val server = currentServer ?: return@runOnUiThread
                val page = webView.url ?: return@runOnUiThread
                if (ServerProfiles.keyOf(page) != ServerProfiles.keyOf(server.url)) return@runOnUiThread
                if (!ServerProfiles.isLoginUrl(page)) return@runOnUiThread
                val user = username.trim()
                if (user.isEmpty() || password.isEmpty() || user.length > 200 || password.length > 1000) return@runOnUiThread
                pendingLogin = user to password
            }
        }

        /** The page auto-clicked Unlock with the remembered login. */
        @JavascriptInterface
        fun autoSignInTried() {
            runOnUiThread { currentServer?.let { autoSubmitted.add(it.id) } }
        }

        /** The Upload button in the Android app. The WebView file input is not used for this path. */
        @JavascriptInterface
        fun pickUpload(parent: String) {
            runOnUiThread {
                val folder = parent.trim()
                if (folder.isEmpty()) return@runOnUiThread
                uploadParent = folder
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                try {
                    uploadLauncher.launch(intent)
                } catch (_: Exception) {
                    uploadParent = null
                    Toast.makeText(this@MainActivity, R.string.upload_failed, Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private data class PendingDownload(
        val url: String,
        val name: String,
        val cookie: String,
        val userAgent: String,
        val size: Long,
        val wifiOnly: Boolean,
    )

    companion object {
        const val UPDATE_CONFIG_URL = "https://mesaandmoon.com/apps/drivebay/version.json"
        private const val PREFS = "drivebay"
        private const val KEY_URL = "server_url"
        private const val KEY_TAILSCALE_SKIP = "tailscale_skip"
        private const val KEY_LEGACY_ACK = "legacy_port_ack"
        private const val KEY_WIFI_ONLY = "wifi_only_large"
        private const val KEY_WIFI_ASKED = "wifi_only_asked"
        private const val TAILSCALE_PACKAGE = "com.tailscale.ipn"
        private const val REQ_NOTIFICATIONS = 21
        private const val REQ_STORAGE = 22
        private val PAGE_HOOK = """
            (function(){
              window.__DRIVEBAY_ANDROID = true;
              if (document.body) document.body.classList.add('android-app');
              if (window.__drivebayFetchPatched || typeof window.fetch !== 'function') return;
              window.__drivebayFetchPatched = true;
              var orig = window.fetch;
              window.fetch = function(input, init) {
                try {
                  var url = (typeof input === 'string') ? input : (input && input.url) ? input.url : '';
                  if (url.indexOf('/api/download') !== -1 && window.DrivebayNative && window.DrivebayNative.download) {
                    var abs = new URL(url, location.href).href;
                    var name = '';
                    try { name = (new URL(abs).searchParams.get('path') || '').split(/[\\/]/).pop() || ''; } catch (e) {}
                    window.DrivebayNative.download(abs, name, '0');
                    return Promise.resolve(new Response(new Blob(), { status: 200 }));
                  }
                } catch (e) {}
                return orig.apply(this, arguments);
              };
            })();
        """.trimIndent()
        /** Watches the Drivebay sign-in form, and fills it from a remembered login when asked. */
        private val LOGIN_HOOK = """
            (function(){
              if (window.__drivebayLoginHooked) return;
              window.__drivebayLoginHooked = true;
              document.addEventListener('submit', function(e) {
                try {
                  var u = document.getElementById('username');
                  var p = document.getElementById('password');
                  if (!u || !p || !window.DrivebayNative || !window.DrivebayNative.loginSubmitted) return;
                  if (u.value && p.value) window.DrivebayNative.loginSubmitted(String(u.value), String(p.value));
                } catch (err) {}
              }, true);
              window.__drivebayFillLogin = function(user, pass, submit) {
                var tries = 0;
                var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                function put(el, v) {
                  setter.call(el, v);
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
                (function attempt() {
                  var u = document.getElementById('username');
                  var p = document.getElementById('password');
                  // Only the normal sign-in form. The first-run "Set the lock" form has a confirm box.
                  if (!u || !p || document.getElementById('confirm')) {
                    if (++tries < 60) setTimeout(attempt, 150);
                    return;
                  }
                  if (p.value) return;
                  put(u, user);
                  put(p, pass);
                  if (!submit || window.__drivebayAutoTried) return;
                  window.__drivebayAutoTried = true;
                  try { window.DrivebayNative.autoSignInTried(); } catch (err) {}
                  setTimeout(function() {
                    var form = p.form;
                    var btn = form && form.querySelector('button[type=submit]');
                    if (btn && !btn.disabled) btn.click();
                  }, 200);
                })();
              };
            })();
        """.trimIndent()
        private val BACK_JS = """
            (function(){
              try {
                if (typeof window.__drivebayAndroidBack !== 'function') return -1;
                return window.__drivebayAndroidBack() ? 1 : 0;
              } catch (e) { return -1; }
            })()
        """.trimIndent()
    }
}
