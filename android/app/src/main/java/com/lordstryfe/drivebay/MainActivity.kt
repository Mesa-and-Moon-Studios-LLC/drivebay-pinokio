package com.lordstryfe.drivebay

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.material.button.MaterialButton
import com.google.android.material.floatingactionbutton.FloatingActionButton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var setupPanel: LinearLayout
    private lateinit var tailscalePanel: LinearLayout
    private lateinit var urlInput: EditText
    private lateinit var connectBtn: MaterialButton
    private lateinit var settingsFab: FloatingActionButton
    private lateinit var wifiOnlyLarge: CheckBox

    private val prefs by lazy { getSharedPreferences(PREFS, Context.MODE_PRIVATE) }
    private var pendingDownload: PendingDownload? = null

    private val finishedReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
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
        super.onCreate(savedInstanceState)

        window.setSoftInputMode(
            WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or
                WindowManager.LayoutParams.SOFT_INPUT_STATE_HIDDEN,
        )
        WindowCompat.setDecorFitsSystemWindows(window, true)

        setContentView(R.layout.activity_main)
        webView = findViewById(R.id.webView)
        setupPanel = findViewById(R.id.setupPanel)
        tailscalePanel = findViewById(R.id.tailscalePanel)
        urlInput = findViewById(R.id.urlInput)
        connectBtn = findViewById(R.id.connectBtn)
        settingsFab = findViewById(R.id.settingsFab)
        wifiOnlyLarge = findViewById(R.id.wifiOnlyLarge)
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
            }
        }
        webView.webChromeClient = WebChromeClient()
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
        settings.allowFileAccess = false
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
            val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(sys.left, sys.top, sys.right, maxOf(ime.bottom, sys.bottom))
            insets
        }

        connectBtn.setOnClickListener { saveAndConnect() }
        settingsFab.setOnClickListener { showSetup(keepUrl = true) }
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
            IntentFilter(DrivebayDownloadService.ACTION_FINISHED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        DrivebayDownloadService.resumeIncomplete(this)
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

    private fun persistAndConnect(url: String) {
        val normalized = ServerAddress.normalize(url)
        prefs.edit().putString(KEY_URL, normalized).apply()
        urlInput.setText(normalized)
        connectTo(normalized)
    }

    private fun connectTo(url: String) {
        showBrowser()
        webView.loadUrl(ServerAddress.homeUrl(url))
    }

    private fun showBrowser() {
        tailscalePanel.visibility = View.GONE
        setupPanel.visibility = View.GONE
        webView.visibility = View.VISIBLE
        settingsFab.visibility = View.VISIBLE
    }

    private fun showSetup(keepUrl: Boolean) {
        if (!keepUrl) urlInput.setText("")
        else if (urlInput.text.isNullOrBlank()) {
            urlInput.setText(prefs.getString(KEY_URL, "") ?: "")
        }
        tailscalePanel.visibility = View.GONE
        webView.visibility = View.GONE
        settingsFab.visibility = View.GONE
        setupPanel.visibility = View.VISIBLE
    }

    private fun showTailscale() {
        webView.visibility = View.GONE
        setupPanel.visibility = View.GONE
        settingsFab.visibility = View.GONE
        tailscalePanel.visibility = View.VISIBLE
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
