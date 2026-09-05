package com.aetherdescent.game;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * The whole app: one WebView showing the game that was packaged into the APK.
 *
 * There is no network code and no INTERNET permission. Everything under
 * assets/www was copied out of the repository when this APK was built, so the
 * game runs with the phone in flight mode and always has.
 */
public class MainActivity extends Activity {

  /** The snapshot the build put in the APK. ?app=1 tells the game it is the packaged build. */
  private static final String GAME_URL = "file:///android_asset/www/index.html?app=1";

  private WebView web;

  @SuppressLint("SetJavaScriptEnabled")
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    // A game is worthless if the screen dims halfway through a boss.
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    // Draw under the notch rather than letterboxing around it.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      getWindow().getAttributes().layoutInDisplayCutoutMode =
          WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
    }

    web = new WebView(this);
    web.setBackgroundColor(0xFF05060C);
    // The canvas is scaled by the page; letting the WebView scale it too would
    // blur every pixel of a pixel-art game.
    web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
    web.setOverScrollMode(View.OVER_SCROLL_NEVER);
    web.setHorizontalScrollBarEnabled(false);
    web.setVerticalScrollBarEnabled(false);
    // A long press would otherwise raise a text-selection menu mid-fight.
    web.setLongClickable(false);
    web.setHapticFeedbackEnabled(false);
    web.setOnLongClickListener(v -> true);

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);          // the game keeps its settings in localStorage
    s.setDatabaseEnabled(true);
    s.setAllowFileAccess(true);            // file:///android_asset
    s.setAllowContentAccess(false);
    s.setMediaPlaybackRequiresUserGesture(false);   // Web Audio starts on the first tap
    s.setSupportZoom(false);
    s.setBuiltInZoomControls(false);
    s.setDisplayZoomControls(false);
    s.setUseWideViewPort(true);
    s.setLoadWithOverviewMode(true);
    s.setCacheMode(WebSettings.LOAD_NO_CACHE);      // the assets ARE the cache
    s.setTextZoom(100);                             // system font scaling must not move the HUD

    web.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
        // Nothing in this build should ever navigate away from the bundle.
        return true;
      }
    });
    web.setWebChromeClient(new WebChromeClient() {
      @Override
      public boolean onConsoleMessage(ConsoleMessage m) {
        android.util.Log.d("AetherDescent", m.message() + " @" + m.lineNumber());
        return true;
      }
    });

    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(0xFF05060C);
    root.addView(web, new FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    setContentView(root);

    if (savedInstanceState != null) web.restoreState(savedInstanceState);
    else web.loadUrl(GAME_URL);
  }

  /** Bars hidden, and they stay hidden when a swipe brings them back. */
  private void goImmersive() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      getWindow().setDecorFitsSystemWindows(false);
      WindowInsetsController c = getWindow().getInsetsController();
      if (c != null) {
        c.hide(WindowInsets.Type.systemBars());
        c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
      }
    } else {
      web.setSystemUiVisibility(
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
    web.onResume();
    web.resumeTimers();
    goImmersive();
  }

  @Override
  protected void onPause() {
    // Stop the loop and the audio when the app goes away, or it keeps running
    // in the background and eats the battery.
    web.onPause();
    web.pauseTimers();
    super.onPause();
  }

  @Override
  protected void onSaveInstanceState(Bundle out) {
    super.onSaveInstanceState(out);
    web.saveState(out);
  }

  @Override
  public boolean onKeyDown(int keyCode, KeyEvent event) {
    // Back pauses the game rather than closing it, by sending the key the game
    // already listens for. A second press with nothing to close leaves.
    if (keyCode == KeyEvent.KEYCODE_BACK) {
      web.evaluateJavascript(
          "(function(){var e=new KeyboardEvent('keydown',{key:'Escape',bubbles:true});"
              + "window.dispatchEvent(e);"
              + "var u=new KeyboardEvent('keyup',{key:'Escape',bubbles:true});"
              + "window.dispatchEvent(u);"
              + "return (window.__game&&window.__game.screen)||'';})();",
          null);
      return true;
    }
    return super.onKeyDown(keyCode, event);
  }

  @Override
  protected void onDestroy() {
    if (web != null) {
      web.loadUrl("about:blank");
      web.destroy();
      web = null;
    }
    super.onDestroy();
  }
}
