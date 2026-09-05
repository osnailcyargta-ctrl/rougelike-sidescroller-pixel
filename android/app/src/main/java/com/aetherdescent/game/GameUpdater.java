package com.aetherdescent.game;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Fetches a newer copy of the game, if there is one and the phone is online.
 *
 * Every part of this is allowed to fail. A refused connection, a timeout, a
 * malformed manifest, a file whose hash does not match - all of them end the
 * same way: nothing is changed and the copy already on the device is used. The
 * game is inside the APK, so there is always something to fall back to.
 */
final class GameUpdater {

  /** Where the web copy lives. Branch is the release channel for the app. */
  private static final String BASE =
      "https://raw.githubusercontent.com/osnailcyargta-ctrl/rougelike-sidescroller-pixel/claude/android-apk/";
  private static final String MANIFEST = "webapp.json";

  private static final int CONNECT_MS = 5000;
  private static final int READ_MS = 8000;
  /** No single file in this game is anywhere near this big. */
  private static final int MAX_FILE = 4 * 1024 * 1024;

  interface Progress {
    /** stage is what to show the player; done/total drive the bar (total 0 = indeterminate). */
    void on(String stage, int done, int total);
  }

  private final Context ctx;
  private final GameFiles files;

  GameUpdater(Context ctx, GameFiles files) {
    this.ctx = ctx.getApplicationContext();
    this.files = files;
  }

  /** A connection the system believes actually reaches the internet. */
  boolean online() {
    try {
      ConnectivityManager cm =
          (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
      if (cm == null) return false;
      Network n = cm.getActiveNetwork();
      if (n == null) return false;
      NetworkCapabilities caps = cm.getNetworkCapabilities(n);
      return caps != null
          && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
          && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
    } catch (Exception e) {
      return false;
    }
  }

  /**
   * Check, and download if there is anything new.
   *
   * @return true if the files on disk were replaced, false if nothing changed
   *         for any reason at all.
   */
  boolean run(Progress progress) {
    if (!online()) return false;
    try {
      progress.on("CHECKING FOR AN UPDATE", 0, 0);
      byte[] raw = fetch(BASE + MANIFEST);
      if (raw == null) return false;

      JSONObject remote = new JSONObject(new String(raw, "UTF-8"));
      Map<String, String> want = parse(remote);
      if (want.isEmpty()) return false;

      // What is already here, so an update only pulls what actually changed.
      // The hashes decide, not the commit label: if every file matches there
      // is nothing to do, whatever the two manifests call themselves.
      Map<String, String> have = parse(localManifest());
      if (sameSet(want, have)) return false;

      files.clearStaging();
      File stage = files.stageDir();
      int total = want.size(), done = 0;
      List<String> failed = new ArrayList<>();

      for (Map.Entry<String, String> e : want.entrySet()) {
        String path = e.getKey(), sha = e.getValue();
        progress.on("DOWNLOADING", done, total);
        byte[] data;
        if (sha.equals(have.get(path)) && files.exists(path)) {
          data = files.read(path);          // unchanged: take the copy we have
        } else {
          data = fetch(BASE + path);
        }
        if (data == null || !sha256(data).equalsIgnoreCase(sha)) {
          failed.add(path);
          break;                            // one bad file voids the whole update
        }
        GameFiles.write(new File(stage, path), data);
        done++;
      }

      if (!failed.isEmpty() || done != total) {
        files.clearStaging();
        return false;
      }
      // The manifest goes in last, so a set of files is only ever described by
      // a manifest that matches it.
      GameFiles.write(new File(stage, MANIFEST), raw);

      progress.on("INSTALLING", total, total);
      boolean ok = files.promoteStaging();
      if (!ok) files.clearStaging();
      return ok;
    } catch (Exception e) {
      files.clearStaging();
      return false;
    }
  }

  /** The manifest describing what is on the device right now. */
  JSONObject localManifest() {
    try {
      return new JSONObject(new String(files.read(MANIFEST), "UTF-8"));
    } catch (Exception e) {
      return new JSONObject();
    }
  }

  String localCommit() { return localManifest().optString("commit", "?"); }

  private static Map<String, String> parse(JSONObject o) {
    Map<String, String> out = new LinkedHashMap<>();
    JSONArray arr = o.optJSONArray("files");
    if (arr == null) return out;
    for (int i = 0; i < arr.length(); i++) {
      JSONObject f = arr.optJSONObject(i);
      if (f == null) continue;
      String p = f.optString("path", "");
      String s = f.optString("sha256", "");
      // A path that climbs out of the game directory is not a game file.
      if (p.isEmpty() || s.isEmpty() || p.startsWith("/") || p.contains("..")) continue;
      out.put(p, s);
    }
    return out;
  }

  private static boolean sameSet(Map<String, String> a, Map<String, String> b) {
    if (a.size() != b.size()) return false;
    for (Map.Entry<String, String> e : a.entrySet()) {
      if (!e.getValue().equals(b.get(e.getKey()))) return false;
    }
    return true;
  }

  private static byte[] fetch(String url) {
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) new URL(url).openConnection();
      c.setConnectTimeout(CONNECT_MS);
      c.setReadTimeout(READ_MS);
      c.setInstanceFollowRedirects(true);
      c.setRequestProperty("Accept-Encoding", "identity");
      if (c.getResponseCode() != 200) return null;
      if (c.getContentLength() > MAX_FILE) return null;
      try (InputStream in = c.getInputStream()) {
        byte[] data = GameFiles.drain(in);
        return data.length <= MAX_FILE ? data : null;
      }
    } catch (Exception e) {
      return null;
    } finally {
      if (c != null) c.disconnect();
    }
  }

  private static String sha256(byte[] data) {
    try {
      byte[] d = MessageDigest.getInstance("SHA-256").digest(data);
      StringBuilder sb = new StringBuilder(d.length * 2);
      for (byte b : d) sb.append(Character.forDigit((b >> 4) & 0xf, 16))
                          .append(Character.forDigit(b & 0xf, 16));
      return sb.toString();
    } catch (Exception e) {
      return "";
    }
  }
}
