package com.aetherdescent.game;

import android.content.Context;
import android.content.res.AssetManager;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Where the game's files live and how they are read.
 *
 * There are two copies. The one inside the APK was put there when the APK was
 * built and can never go missing; the one in internal storage only exists if
 * an update has been downloaded and verified. Reads prefer the downloaded copy
 * and fall back to the packaged one, per file, so a half-finished update can
 * never leave a hole.
 */
final class GameFiles {

  static final String ASSET_ROOT = "www";
  private static final String LIVE_DIR = "www";
  private static final String STAGE_DIR = "www-staging";

  private final Context ctx;

  GameFiles(Context ctx) { this.ctx = ctx.getApplicationContext(); }

  /** The downloaded copy, which may not exist. */
  File liveDir() { return new File(ctx.getFilesDir(), LIVE_DIR); }

  /** Where a download is assembled before it is allowed to replace anything. */
  File stageDir() { return new File(ctx.getFilesDir(), STAGE_DIR); }

  /** Open a game file: downloaded copy first, packaged copy second. */
  InputStream open(String path) throws IOException {
    File f = new File(liveDir(), path);
    if (f.isFile()) return new FileInputStream(f);
    return ctx.getAssets().open(ASSET_ROOT + "/" + path);
  }

  boolean exists(String path) {
    if (new File(liveDir(), path).isFile()) return true;
    try (InputStream in = ctx.getAssets().open(ASSET_ROOT + "/" + path)) {
      return true;
    } catch (IOException e) {
      return false;
    }
  }

  byte[] read(String path) throws IOException {
    try (InputStream in = open(path)) {
      return drain(in);
    }
  }

  static byte[] drain(InputStream in) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream(1 << 16);
    byte[] buf = new byte[8192];
    int n;
    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    return out.toByteArray();
  }

  static void write(File dest, byte[] data) throws IOException {
    File parent = dest.getParentFile();
    if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
      throw new IOException("cannot create " + parent);
    }
    try (OutputStream out = new FileOutputStream(dest)) {
      out.write(data);
    }
  }

  /**
   * Put the staged download in place. The old copy is moved aside first and
   * only deleted once the new one is there, so a crash mid-swap leaves either
   * the old set or the new one - never half of each.
   */
  boolean promoteStaging() {
    File live = liveDir(), stage = stageDir();
    if (!stage.isDirectory()) return false;
    File old = new File(ctx.getFilesDir(), LIVE_DIR + "-old");
    deleteTree(old);
    if (live.isDirectory() && !live.renameTo(old)) return false;
    if (!stage.renameTo(live)) {
      old.renameTo(live);          // put it back; the update simply did not happen
      return false;
    }
    deleteTree(old);
    return true;
  }

  void clearStaging() { deleteTree(stageDir()); }

  static void deleteTree(File f) {
    if (f == null || !f.exists()) return;
    File[] kids = f.listFiles();
    if (kids != null) for (File k : kids) deleteTree(k);
    f.delete();
  }

  /** Copy the packaged bundle out of the APK, used to seed a staging build. */
  void copyAssetTo(String path, File dest) throws IOException {
    AssetManager am = ctx.getAssets();
    try (InputStream in = am.open(ASSET_ROOT + "/" + path)) {
      write(dest, drain(in));
    }
  }
}
