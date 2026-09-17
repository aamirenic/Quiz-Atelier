package com.quizatelier.app

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader

/**
 * Quiz Atelier — standalone Android wrapper.
 *
 * Serves the bundled web app from /assets/www via WebViewAssetLoader
 * (clean https://appassets.androidplatform.net origin, so localStorage,
 * fetch(), and service-style caching all behave exactly as on the web).
 * The app is fully offline; only Gemini calls and optional cloud sync hit
 * the network.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    // Chrome's <input type="file"> fires onShowFileChooser; we bridge it to the
    // Activity Result API (the old onActivityResult pattern is deprecated).
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private lateinit var filePickerLauncher: ActivityResultLauncher<Array<String>>

    companion object {
        private const val TAG = "QuizAtelier"
        private const val START_URL = "https://appassets.androidplatform.net/assets/www/index.html"
        private const val PICKER_MIME = "*/*" // the web app validates PDF/JSON itself
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        webView.id = View.generateViewId()
        setContentView(webView)

        configureWebView()

        // System back button: walk WebView history first, exit only at the root.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })

        filePickerLauncher =
            registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris: List<Uri> ->
                val callback = filePathCallback
                filePathCallback = null
                if (callback == null) return@registerForActivityResult
                if (uris.isEmpty()) {
                    callback.onReceiveValue(null) // user cancelled — must always answer
                    return@registerForActivityResult
                }
                // Grant read access for the lifetime of this process so the
                // WebView can stream the file into FormData/Filereader.
                val out = uris.map { uri ->
                    runCatching {
                        contentResolver.takePersistableUriPermission(
                            uri,
                            Intent.FLAG_GRANT_READ_URI_PERMISSION
                        )
                    }
                    uri
                }.toTypedArray()
                callback.onReceiveValue(out)
            }

        if (savedInstanceState != null) {
            // Rotation / process restore: the WebView keeps its own back stack.
            webView.restoreState(savedInstanceState)
        } else {
            webView.loadUrl(START_URL)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                val url = request.url
                // Our own origin (and its subresources) load in-app.
                if (url.host == "appassets.androidplatform.net") return false
                // Real external links (rare) open in the browser.
                if (url.scheme == "http" || url.scheme == "https") {
                    return try {
                        startActivity(Intent(Intent.ACTION_VIEW, url))
                        true
                    } catch (e: ActivityNotFoundException) {
                        Log.w(TAG, "No browser for $url")
                        true // swallow — don't render a foreign page in-app
                    }
                }
                return true // mailto:, intent:, etc. — never render in the WebView
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                // One picker at a time; answering the old callback prevents
                // the "chromium: duplicate showFileChooser result" crash.
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                return try {
                    filePickerLauncher.launch(arrayOf(PICKER_MIME))
                    true
                } catch (e: ActivityNotFoundException) {
                    filePathCallback = null
                    Log.w(TAG, "No file picker available", e)
                    false
                }
            }

            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                // Web app errors surface in logcat under a greppable tag.
                Log.d(TAG, "[js:${message.messageLevel()}] ${message.message()}" +
                        " (${message.sourceId()}:${message.lineNumber()})")
                return true
            }
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // localStorage: the app's offline store
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = false           // everything via the asset loader origin
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
            builtInZoomControls = false       // the app manages its own viewport
            displayZoomControls = false
            loadWithOverviewMode = true
            useWideViewPort = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, false) // nothing third-party by design
        }

        webView.setBackgroundColor(0xEFE7D2.toInt()) // match windowBackground: no white flash
    }

    /** Exposed for future JS↔native hooks; unused by the wrapper today. */
    fun postMessageToWebApp(json: String) {
        webView.evaluateJavascript("window.__nativeMessage?.($json)", null)
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        webView.apply {
            loadUrl("about:blank")
            (parent as? android.view.ViewGroup)?.removeView(this)
            destroy()
        }
        super.onDestroy()
    }
}
