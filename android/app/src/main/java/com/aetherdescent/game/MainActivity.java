package com.aetherdescent.game;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.webkit.WebViewAssetLoader;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The whole app: one WebView showing the game.
 *
 * The game is served over https://appassets.androidplatform.net/ rather than
 * file://. That is not decoration - it is the difference between working and
 * not. The game is ES modules, and a module script fetched from a file:// page
 * has an opaque origin, so Chromium refuses it by CORS: the page paints, the
 * script never runs, and you are left tapping a "click to start" that has
 * nothing behind it. An https origin also gives localStorage one identity that
 * survives an update, so settings and unlocks are not lost.
 */
public class MainActivity extends Activity {

  private static final String ORIGIN = "https://appassets.androidplatform.net";
  private static final String PAGE = ORIGIN + "/index.html?app=1";

  private WebView web;
  private View splash;
  private TextView splashLine;
  private TextView splashVersion;
  private ProgressBar splashBar;

  private GameFiles files;
  private GameUpdater updater;
  private final Handler ui = new Handler(Looper.getMainLooper());
  private ExecutorService work;
  private boolean loaded;

  @SuppressLint("SetJavaScriptEnabled")
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    files = new GameFiles(this);
    updater = new GameUpdater(this, files);

    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      getWindow().getAttributes().layoutInDisplayCutoutMode =
          WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
    }

    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(0xFF05060C);
    root.addView(buildWeb(), matchParent());
    splash = buildSplash();
    root.addView(splash, matchParent());
    setContentView(root);

    work = Executors.newSingleThreadExecutor();
    // A cold start is the only time this runs. Coming back from the background
    // does not re-check: the activity is still here and the game is mid-run.
    work.execute(this::startup);
  }

  // --- the game view --------------------------------------------------------

  private WebView buildWeb() {
    web = new WebView(this);
    web.setBackgroundColor(0xFF05060C);
    web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
    web.setOverScrollMode(View.OVER_SCROLL_NEVER);
    web.setHorizontalScrollBarEnabled(false);
    web.setVerticalScrollBarEnabled(false);
    web.setLongClickable(false);
    web.setHapticFeedbackEnabled(false);
    web.setOnLongClickListener(v -> true);

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setAllowFileAccess(false);          // nothing is served from file:// any more
    s.setAllowContentAccess(false);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setSupportZoom(false);
    s.setBuiltInZoomControls(false);
    s.setDisplayZoomControls(false);
    s.setUseWideViewPort(true);
    s.setLoadWithOverviewMode(true);
    s.setCacheMode(WebSettings.LOAD_NO_CACHE);
    s.setTextZoom(100);                   // system font scaling must not move the HUD

    final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
        .setDomain("appassets.androidplatform.net")
        .addPathHandler("/", new GameHandler())
        .build();

    web.setWebViewClient(new WebViewClient() {
      @Override
      public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
        return loader.shouldInterceptRequest(req.getUrl());
      }

      @Override
      public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
        // Nothing in this build should navigate off its own origin.
        return !String.valueOf(req.getUrl()).startsWith(ORIGIN);
      }

      @Override
      public void onPageFinished(WebView v, String url) {
        // The page painting is not the same as the game running. Ask it
        // directly, because a page that renders and does nothing is exactly
        // the failure this build had: a module blocked by CORS leaves a
        // "click to start" with nothing behind it, and silently.
        ui.postDelayed(() -> confirmBooted(0), 150);
      }
    });

    web.setWebChromeClient(new WebChromeClient() {
      @Override
      public boolean onConsoleMessage(ConsoleMessage m) {
        android.util.Log.d("AetherDescent", m.message() + " @" + m.lineNumber());
        return true;
      }
    });
    return web;
  }

  /**
   * Serves the game: the downloaded copy if there is one, otherwise the copy
   * inside the APK. The MIME type matters - a module served as anything but
   * JavaScript is refused by the browser, which would put us straight back to
   * a page that paints and does nothing.
   */
  private final class GameHandler implements WebViewAssetLoader.PathHandler {
    private final Map<String, String> types = new HashMap<>();

    GameHandler() {
      types.put("html", "text/html");
      types.put("js", "text/javascript");
      types.put("mjs", "text/javascript");
      types.put("css", "text/css");
      types.put("json", "application/json");
      types.put("png", "image/png");
      types.put("shdr", "text/plain");
      types.put("md", "text/plain");
    }

    @Override
    public WebResourceResponse handle(String path) {
      if (path.startsWith("/")) path = path.substring(1);
      if (path.isEmpty()) path = "index.html";
      if (path.contains("..")) return notFound();
      try {
        InputStream in = files.open(path);
        String ext = path.substring(path.lastIndexOf('.') + 1).toLowerCase();
        String mime = types.containsKey(ext) ? types.get(ext) : "application/octet-stream";
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        WebResourceResponse r =
            new WebResourceResponse(mime, "utf-8", 200, "OK", headers, in);
        return r;
      } catch (IOException e) {
        return notFound();
      }
    }

    private WebResourceResponse notFound() {
      return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
          new HashMap<>(), new java.io.ByteArrayInputStream(new byte[0]));
    }
  }

  // --- the loading screen ---------------------------------------------------

  private View buildSplash() {
    LinearLayout col = new LinearLayout(this);
    col.setOrientation(LinearLayout.VERTICAL);
    col.setGravity(Gravity.CENTER);
    col.setBackgroundColor(0xFF05060C);
    // it sits over the WebView, so it has to swallow taps meant for nothing
    col.setClickable(true);

    TextView title = new TextView(this);
    title.setText("AETHER DESCENT");
    title.setTextColor(0xFFFFB43C);
    title.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
    title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
    title.setLetterSpacing(0.25f);
    title.setGravity(Gravity.CENTER);
    col.addView(title);

    splashBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
    splashBar.setIndeterminate(true);
    LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(dp(220), dp(4));
    bp.topMargin = dp(18);
    splashBar.setLayoutParams(bp);
    col.addView(splashBar);

    splashLine = new TextView(this);
    splashLine.setText("STARTING");
    splashLine.setTextColor(0xFF9A8A63);
    splashLine.setTypeface(Typeface.MONOSPACE);
    splashLine.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
    splashLine.setGravity(Gravity.CENTER);
    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    lp.topMargin = dp(14);
    splashLine.setLayoutParams(lp);
    col.addView(splashLine);

    splashVersion = new TextView(this);
    splashVersion.setTextColor(0xFF4A4258);
    splashVersion.setTypeface(Typeface.MONOSPACE);
    splashVersion.setTextSize(TypedValue.COMPLEX_UNIT_SP, 9);
    splashVersion.setGravity(Gravity.CENTER);
    LinearLayout.LayoutParams vp = new LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    vp.topMargin = dp(8);
    splashVersion.setLayoutParams(vp);
    col.addView(splashVersion);

    return col;
  }

  private void say(String line, int done, int total) {
    ui.post(() -> {
      if (splashLine == null) return;
      splashLine.setText(total > 0 ? line + "  " + done + "/" + total : line);
      if (splashBar != null) {
        if (total > 0) {
          splashBar.setIndeterminate(false);
          splashBar.setMax(total);
          splashBar.setProgress(done);
        } else {
          splashBar.setIndeterminate(true);
        }
      }
    });
  }

  /**
   * Wait for the game object to appear, then get out of the way. If it never
   * appears, say so on screen rather than leaving a dead overlay to tap at.
   */
  private void confirmBooted(int attempt) {
    if (web == null) return;
    web.evaluateJavascript("(typeof window.__game !== 'undefined')", value -> {
      if ("true".equals(value)) {
        hideSplash();
      } else if (attempt < 20) {
        say("STARTING", 0, 0);
        ui.postDelayed(() -> confirmBooted(attempt + 1), 250);
      } else {
        say("THE GAME DID NOT START - SEE 'AetherDescent' IN LOGCAT", 0, 0);
        if (splashBar != null) splashBar.setIndeterminate(false);
      }
    });
  }

  private void hideSplash() {
    if (splash == null || splash.getVisibility() != View.VISIBLE) return;
    splash.animate().alpha(0f).setDuration(220).withEndAction(() -> {
      if (splash != null) splash.setVisibility(View.GONE);
    }).start();
  }

  // --- start up -------------------------------------------------------------

  /**
   * Runs off the main thread. Offline, this does nothing at all and the game
   * starts immediately from what is already on the device; online, it looks
   * for a newer copy first.
   */
  private void startup() {
    ui.post(() -> splashVersion.setText("BUILD " + updater.localCommit()));
    if (updater.online()) {
      updater.run(this::say);
    } else {
      say("OFFLINE - PLAYING WHAT IS INSTALLED", 0, 0);
    }
    ui.post(() -> {
      splashVersion.setText("BUILD " + updater.localCommit());
      say("STARTING", 0, 0);
      if (!loaded) {
        loaded = true;
        web.loadUrl(PAGE);
      }
    });
  }

  // --- window plumbing ------------------------------------------------------

  private static FrameLayout.LayoutParams matchParent() {
    return new FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT);
  }

  private int dp(int v) {
    return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
        getResources().getDisplayMetrics()));
  }

  private void goImmersive() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      getWindow().setDecorFitsSystemWindows(false);
      WindowInsetsController c = getWindow().getInsetsController();
      if (c != null) {
        c.hide(WindowInsets.Type.systemBars());
        c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
      }
    } else {
      getWindow().getDecorView().setSystemUiVisibility(
          View.SYSTEM_UI_FLAG_LAYOUT_STABLE
              | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
              | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
              | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
              | View.SYSTEM_UI_FLAG_FULLSCREEN
              | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) goImmersive();
  }

  @Override
  protected void onResume() {
    super.onResume();
    if (web != null) { web.onResume(); web.resumeTimers(); }
    goImmersive();
  }

  @Override
  protected void onPause() {
    if (web != null) { web.onPause(); web.pauseTimers(); }
    super.onPause();
  }

  @Override
  public boolean onKeyDown(int keyCode, KeyEvent event) {
    if (keyCode == KeyEvent.KEYCODE_BACK && web != null) {
      // Escape is what the game already uses to pause and to close a popup,
      // so back does that rather than dropping a run on the floor.
      web.evaluateJavascript(
          "(function(){var d=new KeyboardEvent('keydown',{key:'Escape',bubbles:true});"
              + "window.dispatchEvent(d);"
              + "var u=new KeyboardEvent('keyup',{key:'Escape',bubbles:true});"
              + "window.dispatchEvent(u);})();",
          null);
      return true;
    }
    return super.onKeyDown(keyCode, event);
  }

  @Override
  protected void onDestroy() {
    if (work != null) work.shutdownNow();
    if (web != null) {
      web.loadUrl("about:blank");
      web.destroy();
      web = null;
    }
    super.onDestroy();
  }
}
