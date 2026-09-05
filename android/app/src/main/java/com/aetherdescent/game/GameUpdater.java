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
 * The app follows the web branch directly and works out for itself what the
 * game is made of: GitHub is asked for the branch's file tree, which already
 * carries a hash per file, so nothing in the repository has to be kept in step
 * by hand. Adding a module to the game is enough - the next launch sees it.
 *
 * Every part of this is allowed to fail. A refused connection, a timeout, a
 * rate limit, a file whose hash does not match - all of them end the same way:
 * nothing is changed and the copy already on the device is used. The game is
 * inside the APK, so there is always something to fall back to.
 */
final class GameUpdater {

  private static final String REPO = "osnailcyargta-ctrl/rougelike-sidescroller-pixel";
  /** The branch the game itself lives on. This is the release channel. */
  private static final String BRANCH = "claude/roguelike-pixel-sidescroller-nmg0i5";

  private static final String TREE =
      "https://api.github.com/repos/" + REPO + "/git/trees/" + BRANCH + "?recursive=1";
  private static final String RAW =
      "https://raw.githubusercontent.com/" + REPO + "/" + BRANCH + "/";

  /** What the device remembers about the copy it is holding. */
  private static final String STATE = "version.json";

  private static final int CONNECT_MS = 5000;
  private static final int READ_MS = 8000;
  /** No single file in this game is anywhere near this big. */
  private static final int MAX_FILE = 4 * 1024 * 1024;
  /** The tree listing is small; anything larger is not the tree. */
  private static final int MAX_TREE = 2 * 1024 * 1024;
  /** A game made of fewer files than this is not a game. Refuse to install it. */
  private static final int MIN_FILES = 10;

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
      byte[] raw = fetch(TREE, MAX_TREE, true);
      if (raw == null) return false;

      JSONObject tree = new JSONObject(new String(raw, "UTF-8"));
      Map<String, String> want = parseTree(tree);
      if (want.size() < MIN_FILES) return false;

      // What is already here, hashed the same way GitHub hashes it. The files
      // decide, not a label: if every one of them matches there is nothing to
      // do, and a file we cannot read is simply one that needs downloading.
      Map<String, byte[]> have = new LinkedHashMap<>();
      List<String> stale = new ArrayList<>();
      for (Map.Entry<String, String> e : want.entrySet()) {
        byte[] local = readOrNull(e.getKey());
        if (local != null && gitSha1(local).equalsIgnoreCase(e.getValue())) {
          have.put(e.getKey(), local);
        } else {
          stale.add(e.getKey());
        }
      }
      if (stale.isEmpty()) {
        // Already current. Record the tree so the splash can name the version
        // even on a device that has never downloaded anything.
        note(tree.optString("sha", ""), want.size());
        return false;
      }

      files.clearStaging();
      File stage = files.stageDir();
      int total = want.size(), done = 0;

      for (Map.Entry<String, String> e : want.entrySet()) {
        String path = e.getKey(), sha = e.getValue();
        progress.on("DOWNLOADING", done, total);
        byte[] data = have.get(path);              // unchanged: keep what we have
        if (data == null) data = fetch(RAW + path, MAX_FILE, false);
        if (data == null || !gitSha1(data).equalsIgnoreCase(sha)) {
          files.clearStaging();                    // one bad file voids the update
          return false;
        }
        GameFiles.write(new File(stage, path), data);
        done++;
      }
      if (done != total) { files.clearStaging(); return false; }

      // The state file goes in last, so a set of files is only ever described
      // by a record that matches it.
      GameFiles.write(new File(stage, STATE), stateJson(tree.optString("sha", ""), total));

      progress.on("INSTALLING", total, total);
      boolean ok = files.promoteStaging();
      if (!ok) files.clearStaging();
      return ok;
    } catch (Exception e) {
      files.clearStaging();
      return false;
    }
  }

  /** A short name for the copy on the device, for the splash to show. */
  String localCommit() {
    try {
      String s = new JSONObject(new String(files.read(STATE), "UTF-8")).optString("tree", "");
      if (!s.isEmpty()) return s.substring(0, Math.min(7, s.length()));
    } catch (Exception ignored) {
    }
    try {
      // Never updated: name the copy that was packaged with the APK.
      return new JSONObject(new String(files.read("build.json"), "UTF-8"))
          .optString("commit", "?");
    } catch (Exception e) {
      return "?";
    }
  }

  /**
   * Remember the tree we are holding without touching the game files. Written
   * beside the live copy only when there is one; a device still running the
   * packaged bundle keeps naming itself by the build it shipped with.
   */
  private void note(String treeSha, int count) {
    try {
      File live = files.liveDir();
      if (treeSha.isEmpty() || !live.isDirectory()) return;
      GameFiles.write(new File(live, STATE), stateJson(treeSha, count));
    } catch (Exception ignored) {
    }
  }

  private static byte[] stateJson(String treeSha, int count) throws Exception {
    JSONObject o = new JSONObject();
    o.put("tree", treeSha);
    o.put("branch", BRANCH);
    o.put("files", count);
    o.put("at", System.currentTimeMillis());
    return o.toString().getBytes("UTF-8");
  }

  private byte[] readOrNull(String path) {
    try {
      return files.read(path);
    } catch (Exception e) {
      return null;
    }
  }

  /**
   * The game files out of a GitHub tree listing, each with the blob hash
   * GitHub already computed. Anything that is not part of the game - the
   * Android project, the workflows, notes - is ignored, so the app downloads a
   * game and nothing else.
   */
  private static Map<String, String> parseTree(JSONObject tree) {
    Map<String, String> out = new LinkedHashMap<>();
    // A truncated listing is a partial game, and a partial game is not one.
    if (tree.optBoolean("truncated", false)) return out;
    JSONArray arr = tree.optJSONArray("tree");
    if (arr == null) return out;
    for (int i = 0; i < arr.length(); i++) {
      JSONObject f = arr.optJSONObject(i);
      if (f == null || !"blob".equals(f.optString("type"))) continue;
      String p = f.optString("path", "");
      String sha = f.optString("sha", "");
      if (p.isEmpty() || sha.isEmpty() || p.startsWith("/") || p.contains("..")) continue;
      if (f.optLong("size", 0) > MAX_FILE) continue;
      if (!isGameFile(p)) continue;
      out.put(p, sha);
    }
    return out;
  }

  private static boolean isGameFile(String p) {
    if (p.equals("index.html")) return true;
    if (p.startsWith("js/") && p.endsWith(".js")) return true;
    if (p.startsWith("css/") && p.endsWith(".css")) return true;
    if (p.startsWith("shaders/") && p.endsWith(".shdr")) return true;
    return false;
  }

  private static byte[] fetch(String url, int max, boolean api) {
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) new URL(url).openConnection();
      c.setConnectTimeout(CONNECT_MS);
      c.setReadTimeout(READ_MS);
      c.setInstanceFollowRedirects(true);
      c.setRequestProperty("Accept-Encoding", "identity");
      c.setRequestProperty("User-Agent", "AetherDescent-Android");
      if (api) c.setRequestProperty("Accept", "application/vnd.github+json");
      if (c.getResponseCode() != 200) return null;
      if (c.getContentLength() > max) return null;
      try (InputStream in = c.getInputStream()) {
        byte[] data = GameFiles.drain(in);
        return data.length <= max ? data : null;
      }
    } catch (Exception e) {
      return null;
    } finally {
      if (c != null) c.disconnect();
    }
  }

  /**
   * The hash git gives a file: sha1 over "blob <length>\0" and the bytes. It
   * is what the tree listing carries, so hashing this way means the check is
   * against GitHub's own idea of the file rather than a second list that could
   * disagree with it.
   */
  static String gitSha1(byte[] data) {
    try {
      MessageDigest md = MessageDigest.getInstance("SHA-1");
      md.update(("blob " + data.length + "\0").getBytes("UTF-8"));
      md.update(data);
      byte[] d = md.digest();
      StringBuilder sb = new StringBuilder(d.length * 2);
      for (byte b : d) sb.append(Character.forDigit((b >> 4) & 0xf, 16))
                         .append(Character.forDigit(b & 0xf, 16));
      return sb.toString();
    } catch (Exception e) {
      return "";
    }
  }
}
