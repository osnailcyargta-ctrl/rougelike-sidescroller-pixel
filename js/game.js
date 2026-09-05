// Game shell: canvas setup, main loop, run/room/wave state machine.
import { clamp, lerp, rand, randInt, dist, distToSegment, rgba, sign, snapAngle, setSeed, getSeed, randomSeedText, streamFor, TAU } from './util.js';
import { Theme, applyTheme, resetTheme, DEFAULT_THEME } from './theme.js';
import {
  Camera, updateFx, drawParticles, drawTexts, drawRings, clearFx, burst, floatText,
  spawnParticle, impactRing, boltPath, strokeBolt, glowDot, pxRect, screenFlash, drawFlash,
} from './gfx.js';
import { Input, initInput, inputTick, inputEndFrame, Binds } from './input.js';
import { Sfx, resumeAudio, setVolume, AudioCfg } from './audio.js';
import { PostFX, parseShaderPack, DEFAULT_COMPOSITE } from './postfx.js';
import {
  VIEW_W, VIEW_H, GROUND_Y, PLATFORMS, DROP_POINT, PERK, WAVES, PLAYER as PCFG,
  BOSS_ROOM_INTERVAL, NUKERANG, FINAL_ROOM, SHARDGUN, TWINDAGGER, SWORD, BOW, ORIGAMI,
  ARMOR, PAPER_SHIELD, ANVIL, GRAPPLE, STINGER_GUN, BLOCK, DROPS, GIANT_EGG, FORGE_VISIBLE_ROWS,
  HITBOX,
  SEEDED_THROUGH_ROOM, SOUL_DART, STIDENT, BOSS_RUSH,
} from './config.js';
import { Player, Enemy, Projectile, SHARD_TINT, INK, doodleShape, doodleLine } from './entities.js';
import { makeBoss, makeBossPreview } from './boss.js';
import { Cutscene } from './cutscene.js';
import {
  CODEX_ORDER, codexEntry, codexView, markBossDefeated, resetCodex,
  loadUnlocks, checkBossRushUnlock,
} from './codex.js';
import { drawBackground, drawArena, drawLightShafts, drawSpawnPads, updateWorld, buildWave, activeSpawnPads, Pickup, Portal, Anvil } from './world.js';
import { ITEMS, RARITY, HOTBAR_SIZE, DROP_POOL, UNIQUE_ONCE, rollDrop, rollPerkPair, drawItemIcon } from './items.js';
import { UI, uiBeginFrame, drawHUD, drawInventory, drawTooltip, drawDebugMenu, drawFoldWheel, drawForge, drawCodex, panel, button } from './ui.js';
import { updateTouchPad, drawTouchPad, drawAimLeash, Pad } from './touch.js';
import { Perf, perfTick, syncPerfOptions, TIERS } from './perf.js';
import { forgeLayout, forgeRowRect, forgeListRect, closeRect, inRect, codexLayout, codexRowRect } from './layout.js';
import { drawText, drawTextShadow } from './font.js';
import { Options, loadOptions, saveOptions, applyVisualOptions, captureShaderBase, saveShader, loadShader } from './settings.js';
import { loadShaderLibrary, saveShaderToLibrary, removeShaderFromLibrary, findShader,
  saveActiveShaderId, loadActiveShaderId } from './shaderlib.js';
import {
  drawMainMenu, drawSettings, drawClassSelect, drawModeSelect, drawWeaponSelect,
  drawPerkSlot, drawRushReward, drawPause, drawGameOver, drawControls, drawVictory,
} from './screens.js';

// Health restored to the player after every cleared wave; clearing a room and
// stepping through the gate restores the rest.
const WAVE_HEAL = 0.25;

// Touch handling for the fold wheel: how far a drag has to travel to step to
// the next fold, and how long you have to hold still before it commits.
const FOLD_DRAG_STEP = 26;
const FOLD_HOLD_TIME = 1.0;

export class Game {
  static get WAVE_HEAL() { return WAVE_HEAL; }

  constructor(root) {
    this.display = root.querySelector('#screen');
    this.scene = document.createElement('canvas');
    this.scene.width = VIEW_W;
    this.scene.height = VIEW_H;
    this.ctx = this.scene.getContext('2d', { alpha: false });
    this.ctx.imageSmoothingEnabled = false;
    // The pixel canvas also sits in the page, laid over the WebGL one. When
    // the post chain is off it is simply shown as it is, which skips handing
    // the frame to the GPU altogether. pointer-events stays off so input
    // still lands on the canvas underneath that owns the listeners.
    this.scene.id = 'raw';
    // matched border and centring so it lands exactly over the other canvas
    this.scene.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);'
      + 'pointer-events:none;image-rendering:pixelated;background:#000;'
      + 'border:2px solid var(--edge);border-radius:3px;visibility:hidden;z-index:2';
    root.appendChild(this.scene);
    this.postfx = new PostFX(this.display, this.scene);

    this.screen = 'menu';
    this.returnScreen = null;
    this.controlsReturn = null;
    this.seedText = '';
    this.runTime = 0;
    this.runStats = null;
    this.time = 0;
    this.freezeT = 0;
    this.screenShake = true;
    this.shaderName = null;
    this.shaderId = null;    // which shelf entry is on, if it came from the shelf
    this.shaderError = null;
    this.deathT = 0;

    this.player = null;
    this.enemies = [];
    this.projectiles = [];
    this.pickups = [];
    this.shockwaves = [];
    this.shields = [];        // orbiting paper plates, if the set is worn
    this.bolts = [];
    this.pendingSpawns = [];
    this.portal = null;
    this.anvil = null;
    this.forge = null;       // the crafting popup, open only while paused
    this.codex = null;       // the bestiary, readable from anywhere
    this.mode = 'normal';    // or 'bossrush'
    this.pendingClass = null;   // chosen on one screen, started on another
    this.weaponPick = null;     // the two-weapon offer Boss Rush opens with
    this.rushWeapon = null;     // and what was taken from it
    this.perkSlot = null;       // the reel that hands over the opening perk
    this.rushReward = null;     // the spoils screen between bosses
    this.boss = null;
    this.cutscene = new Cutscene(this);
    loadUnlocks();
    this.roomIndex = 1;
    this.waveIndex = 1;
    this.roomCleared = false;
    this.waveTimer = 0;
    this.kills = 0;
    this.invOpen = false;
    this.debugOpen = false;
    this.debug = { god: false, infHealth: false };
    this.timeStopT = 0;      // Alphads' held breath
    this.fold = null;        // the origami fold wheel, open only while paused
    this.victoryT = 0;
    this.hint = null;
    this.hintT = 0;

    // saved settings first, so the very first frame already looks right
    loadOptions();
    syncPerfOptions();
    applyVisualOptions();
    setVolume(Options.volume);

    this.resize();
    addEventListener('resize', () => this.resize());
    initInput({
      canvas: this.display,
      toWorld: (sx, sy) => this.toWorld(sx, sy),
      toView: (sx, sy) => this.toView(sx, sy),
    });
    this.setupShaderInput(root);

    // and the shader pack the player was last using. The shelf is asked first:
    // a pack switched on from there is remembered by id, so deleting it turns
    // it off rather than leaving a ghost copy running.
    const activeId = loadActiveShaderId();
    const shelved = activeId ? findShader(activeId) : null;
    if (shelved) {
      this.applyShaderPack(shelved.text, shelved.name, { silent: true, store: false });
      this.shaderId = shelved.id;
    } else {
      const saved = loadShader();
      if (saved) this.applyShaderPack(saved.text, saved.name, { silent: true, store: false });
    }
    // anything shared into the app arrives here, whenever it arrives
    window.__aetherOpenShader = (name, text) => this.openSharedShader(name, text);

    this.last = performance.now();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // --- plumbing ----------------------------------------------------------

  // Fill the viewport. Snapping the scale to a half step keeps the pixel grid
  // even, which is worth having on a desktop window with room to spare - but
  // on a phone the gap between a snapped 1.0 and an exact 1.48 is most of the
  // screen, so there the exact fit wins and the grid gives.
  resize() {
    const fit = Math.min(innerWidth / VIEW_W, innerHeight / VIEW_H);
    const snap = Math.floor(fit * 2) / 2;
    const scale = (snap >= 1 && fit - snap < 0.08) ? snap : Math.max(0.5, fit);
    this.scale = scale;
    const cssW = Math.round(VIEW_W * scale), cssH = Math.round(VIEW_H * scale);
    this.display.style.width = `${cssW}px`;
    this.display.style.height = `${cssH}px`;
    if (this.scene) {
      this.scene.style.width = `${cssW}px`;
      this.scene.style.height = `${cssH}px`;
    }
    // The scene is 480x270 however big the window is, so compositing it at
    // three or four device pixels per source pixel costs fill rate for
    // nothing you can see. Cap it, and lower the cap when the phone is
    // struggling - this is the single biggest lever there is.
    const dpr = Math.min(2, devicePixelRatio || 1);
    const bw = Math.round(Math.min(VIEW_W * scale * dpr, VIEW_W * Perf.pixelCap));
    this.display.width = bw;
    this.display.height = Math.round(bw * (VIEW_H / VIEW_W));
  }

  toWorld(sx, sy) {
    const r = this.display.getBoundingClientRect();
    const vx = (sx / r.width) * VIEW_W;
    const vy = (sy / r.height) * VIEW_H;
    // undo the camera so aiming stays exact through shake and zoom punches
    const w = Camera.unproject(vx, vy);
    return { x: clamp(w.x, -40, VIEW_W + 40), y: clamp(w.y, -40, VIEW_H + 40) };
  }

  // Either composite through the shader chain, or just show the pixel canvas.
  present(dt) {
    const raw = !Perf.postfx;
    if (raw !== this.rawPresent) {
      this.rawPresent = raw;
      // the GL canvas is left in place and still visible underneath: it owns
      // the input listeners, and hiding it would stop them firing. The pixel
      // canvas is opaque and exactly covers it, so its stale frame never shows.
      this.scene.style.visibility = raw ? 'visible' : 'hidden';
    }
    if (!raw) this.postfx.render(dt);
  }

  // Screen space, camera left in. The on-screen pad is bolted to the display,
  // not to the world, so it must not move when the camera shakes.
  toView(sx, sy) {
    const r = this.display.getBoundingClientRect();
    return { x: (sx / r.width) * VIEW_W, y: (sy / r.height) * VIEW_H };
  }

  setupShaderInput(root) {
    this.fileInput = root.querySelector('#shaderFile');
    this.fileInput.addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const text = await f.text();
      this.importShader(f.name.replace(/\.shdr$/i, ''), text);
      this.fileInput.value = '';
    });
    // drag & drop a .shdr anywhere
    addEventListener('dragover', (e) => e.preventDefault());
    addEventListener('drop', async (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (!f || !/\.shdr$/i.test(f.name)) return;
      this.importShader(f.name.replace(/\.shdr$/i, ''), await f.text());
    });
  }

  requestShaderUpload() { this.fileInput.click(); }

  applyShaderPack(text, fallbackName, opts = {}) {
    try {
      const pack = parseShaderPack(text);
      applyTheme(pack.theme);
      // the pack sets the baseline the visual sliders ride on
      captureShaderBase();
      applyVisualOptions();
      if (pack.glsl && /gl_FragColor/.test(pack.glsl)) {
        const err = this.postfx.setComposite(pack.glsl);
        if (err) {
          resetTheme();
          this.postfx.resetComposite();
          this.shaderName = null;
          this.shaderError = 'COMPILE: ' + err.replace(/\n/g, ' ').slice(0, 60);
          return;
        }
      } else {
        this.postfx.resetComposite();
      }
      this.shaderName = (pack.name || fallbackName || 'CUSTOM').toUpperCase();
      this.shaderError = null;
      if (opts.store !== false) saveShader(this.shaderName, text);
      if (!opts.silent) this.toast(`SHADER LOADED: ${this.shaderName}`);
    } catch (err) {
      this.shaderError = String(err.message || err).slice(0, 60);
    }
  }

  // --- the shader shelf ---------------------------------------------------

  /**
   * Take a pack in, put it on the shelf, and switch it on. A pack that will
   * not compile is not shelved: the shelf is things that work.
   */
  importShader(name, text, opts = {}) {
    const before = this.shaderName;
    this.applyShaderPack(text, name, { ...opts, store: false, silent: true });
    if (this.shaderError) {
      this.toast(this.shaderError);
      return null;
    }
    const res = saveShaderToLibrary(this.shaderName || name, text);
    if (!res.ok) {
      // it is running, it just could not be kept - say which, not "failed"
      this.toast(res.error);
      this.shaderId = null;
      saveActiveShaderId(null);
      saveShader(this.shaderName, text);       // at least survive a reload
      return null;
    }
    this.shaderId = res.entry.id;
    saveActiveShaderId(res.entry.id);
    saveShader(this.shaderName, text);
    this.toast(before === this.shaderName ? `SHADER UPDATED: ${this.shaderName}`
                                          : `SHADER SAVED: ${this.shaderName}`);
    return res.entry;
  }

  /** Switch a shelved pack on, or off again if it is the one already on. */
  toggleSavedShader(id) {
    if (this.shaderId === id) { this.resetShader(); return; }
    const entry = findShader(id);
    if (!entry) { this.toast('THAT SHADER IS GONE'); return; }
    this.applyShaderPack(entry.text, entry.name, { store: false, silent: true });
    if (this.shaderError) { this.toast(this.shaderError); return; }
    this.shaderId = entry.id;
    saveActiveShaderId(entry.id);
    saveShader(entry.name, entry.text);
    this.toast(`SHADER ON: ${entry.name}`);
  }

  deleteSavedShader(id) {
    const entry = findShader(id);
    if (!entry) return;
    if (this.shaderId === id) this.resetShader();
    removeShaderFromLibrary(id);
    this.toast(`DELETED: ${entry.name}`);
  }

  savedShaders() { return loadShaderLibrary(); }

  /**
   * A .shdr handed over by the system - Android's open-with or share sheet.
   * It goes on the shelf like any other, so it is there next time too.
   */
  openSharedShader(name, text) {
    const clean = String(name || 'SHARED').replace(/\.shdr$/i, '');
    const entry = this.importShader(clean, String(text ?? ''));
    // The menus are where the result is visible; a run in progress is not
    // interrupted for it.
    return !!entry;
  }

  resetShader() {
    resetTheme();
    captureShaderBase();
    applyVisualOptions();
    this.postfx.resetComposite();
    this.shaderName = null;
    this.shaderId = null;
    this.shaderError = null;
    saveShader(null, null);
    saveActiveShaderId(null);
    this.toast('SHADER RESET');
  }

  downloadSampleShader() {
    const sample = SAMPLE_SHDR;
    const blob = new Blob([sample], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'neon-veil.shdr';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  toast(msg) { this.hint = msg; this.hintT = 2.2; }

  // --- debug spawns ------------------------------------------------------

  debugSpawnEnemy(type) {
    if (!this.player) return;
    const side = Math.random() < 0.5 ? -1 : 1;
    const x = clamp(this.player.x + side * rand(60, 110), 24, VIEW_W - 24);
    this.enemies.push(new Enemy(type, x, GROUND_Y, this));
  }

  debugSpawnBoss(id) {
    if (!this.player) return;
    // retire whatever is already out there, quietly - no death cutscene
    if (this.boss && !this.boss.dead) {
      this.boss.dead = true;
      for (const p of (this.boss.parts ?? [])) p.dead = true;
    }
    this.boss = makeBoss(this, this.roomIndex, id);
    this.boss.intro = 0.6;
    Camera.add(8);
  }

  // Drop straight into a room, skipping everything between here and it. The
  // room is built exactly as the run would build it, so what you land in is
  // the real thing and not a debug approximation of it.
  debugGoToRoom(n) {
    if (!this.player) return;
    const room = clamp(Math.round(n), 1, this.lastRoom);
    // Whatever was mid-flight would otherwise land on top of the new room: a
    // boss outro still running, a spoils screen waiting on a countdown, a
    // stopped clock.
    if (this.cutscene.active) this.cutscene.finish();
    this.rushReward = null;
    this.pendingSpawns.length = 0;
    this.bolts.length = 0;
    this.shockwaves.length = 0;
    this.timeStopT = 0;
    this.freezeT = 0;
    this.invOpen = false;
    this.debugOpen = false;
    this.screen = 'playing';
    this.startRoom(room);
    this.toast(`ROOM ${room}`);
  }

  hitstop(t) { this.freezeT = Math.max(this.freezeT, t); }

  // --- run flow ----------------------------------------------------------

  goClassSelect() { resumeAudio(); this.screen = 'classSelect'; }

  startRun(classId, mode = 'normal', startWeapon = null, startPerk = null) {
    resumeAudio();
    this.mode = mode;
    // an empty field means "surprise me", but the roll is still recorded so the
    // death screen can hand the seed back for a rematch
    this.activeSeed = setSeed(this.seedText.trim() || randomSeedText());
    resetCodex();          // the book records this run, not the last one
    this.runTime = 0;
    this.runStats = null;
    clearFx();
    this.player = new Player(this, classId);
    this.enemies.length = 0;
    this.projectiles.length = 0;
    this.pickups.length = 0;
    this.shockwaves.length = 0;
    this.bolts.length = 0;
    this.shields.length = 0;
    this.kills = 0;
    this.roomIndex = 1;
    this.deathT = 0;
    this.invOpen = false;
    this.boss = null;
    this.screen = 'playing';
    // Boss Rush hands you one weapon of your own choosing instead of the
    // class default, and there is nothing between the bosses to find another.
    if (startWeapon) {
      // whatever the class hands out by default goes back; the pick replaces
      // it. The Origamist keeps its paper - that is ammunition, not a weapon.
      for (const id of ['sword', 'bow', 'bookairplane']) this.player.inventory.remove(id, 1);
      this.player.inventory.add(startWeapon, 1);
      const i = this.player.inventory.slots.findIndex((sl) => sl && sl.id === startWeapon);
      if (i >= 0 && i < HOTBAR_SIZE) this.player.inventory.selected = i;
      this.player.recomputeStats();
    }
    if (startPerk) {
      this.player.inventory.add(startPerk, 1);
      this.player.recomputeStats();
    }
    this.startRoom(1);
  }

  // --- the spoils between bosses -------------------------------------------
  // Three on the table, two taken, then a short count and the next one is on
  // you. Weapons can turn up, but only ones your class can actually use.

  rushRewardPool() {
    const inv = this.player.inventory;
    const cls = this.player.classId;
    const weapons = (BOSS_RUSH.weapons[cls] ?? []).filter((id) => !inv.has(id));
    const perks = DROP_POOL.filter((id) => !(UNIQUE_ONCE.has(id) && inv.has(id)));
    return [...perks, ...weapons];
  }

  openRushReward() {
    const pool = this.rushRewardPool();
    const roll = streamFor(`rush:spoils:${this.roomIndex}`);
    const offer = [];
    const want = Math.min(BOSS_RUSH.rewardOffer, pool.length);
    while (offer.length < want) offer.push(pool.splice(Math.floor(roll() * pool.length), 1)[0]);
    this.rushReward = { offer, taken: [], countdown: null, t: 0 };
    // With nothing left worth offering there is nothing to pick, so the clock
    // starts straight away rather than waiting for a choice that cannot come.
    if (!offer.length) this.rushReward.countdown = BOSS_RUSH.rewardCountdown;
    this.screen = 'rushReward';
    Sfx.pickup();
  }

  takeRushReward(id) {
    const r = this.rushReward;
    if (!r || r.countdown !== null || r.taken.includes(id)) return;
    if (this.player.inventory.add(id, 1) > 0) { this.toast('NO ROOM FOR IT'); Sfx.ui(); return; }
    r.taken.push(id);
    this.player.recomputeStats();
    Sfx.pickup();
    if (r.taken.length >= Math.min(BOSS_RUSH.rewardTake, r.offer.length)) {
      r.countdown = BOSS_RUSH.rewardCountdown;
    }
  }

  updateRushReward(dt) {
    const r = this.rushReward;
    if (!r) { this.screen = 'playing'; return; }
    r.t += dt;
    if (r.countdown === null) return;
    const was = Math.ceil(r.countdown);
    r.countdown -= dt;
    if (Math.ceil(r.countdown) !== was && r.countdown > 0) Sfx.ui();
    if (r.countdown <= 0) {
      this.rushReward = null;
      this.screen = 'playing';
      this.startRoom(this.roomIndex + 1);
    }
  }

  // --- Boss Rush ----------------------------------------------------------
  // Four bosses back to back. Each is its own room, so the perk choice between
  // them is the one a boss room already gives.

  get rushLength() { return BOSS_RUSH.order.length; }

  rushBossFor(index = this.roomIndex) { return BOSS_RUSH.order[index - 1] ?? null; }

  // The last room of whichever mode is running.
  get lastRoom() { return this.mode === 'bossrush' ? this.rushLength : FINAL_ROOM; }

  // Pick the class, then the mode, then - in Boss Rush - the weapon.
  chooseClass(classId) {
    this.pendingClass = classId;
    this.screen = 'modeSelect';
    Sfx.ui();
  }

  beginNormal() {
    this.startRun(this.pendingClass ?? 'melee', 'normal');
  }

  // The offer is rolled from the run's seed, so a seed you liked gives the
  // same two weapons back.
  beginBossRush() {
    const cls = this.pendingClass ?? 'melee';
    const pool = [...(BOSS_RUSH.weapons[cls] ?? BOSS_RUSH.weapons.melee)];
    // Fix the seed HERE, not in startRun: streamFor reads whatever seed is
    // currently set, so rolling the offer first would key it to the previous
    // run's seed instead of this one's.
    this.seedText = setSeed(this.seedText.trim() || randomSeedText());
    const roll = streamFor('rush:weapons');
    // Work out how many to offer BEFORE drawing any: the pool shrinks as they
    // come out, so re-checking its length each pass made a two-weapon class
    // (the Origamist, with two tutors) offer only one.
    const want = Math.min(BOSS_RUSH.weaponPicks, pool.length);
    const offer = [];
    while (offer.length < want) offer.push(pool.splice(Math.floor(roll() * pool.length), 1)[0]);
    this.weaponPick = { classId: cls, offer };
    this.screen = 'weaponSelect';
    Sfx.ui();
  }

  takeRushWeapon(id) {
    this.rushWeapon = id;
    this.openPerkSlot();
  }

  // --- the opening perk -----------------------------------------------------
  // A rush gives you one perk before it starts, won off a reel: it lands where
  // it lands, and you may send it round once more before you have to take what
  // is showing. This is the only one you are handed - there is no second.

  openPerkSlot() {
    this.perkSlot = {
      pool: DROP_POOL.slice(),
      reel: 0,               // position along the strip, in items
      spin: 0,               // time left in this spin
      landed: null,
      rerolls: BOSS_RUSH.slotRerolls,
      t: 0,
    };
    this.screen = 'perkSlot';
    this.spinPerkSlot(true);
  }

  spinPerkSlot(first = false) {
    const sl = this.perkSlot;
    if (!sl) return;
    if (!first && sl.rerolls <= 0) return;
    if (!first) sl.rerolls--;
    // The result is drawn now and the reel is simply made to stop on it - a
    // reel that lands wherever it runs out would be a different distribution
    // from the one the perk weights describe.
    const roll = streamFor(`rush:slot:${sl.rerolls}`);
    // A reroll that hands back what you just rejected reads as a broken
    // button, so it draws from everything except that.
    const draw = first ? sl.pool : sl.pool.filter((id) => id !== sl.landed);
    sl.landed = null;
    sl.result = draw[Math.floor(roll() * draw.length)] ?? sl.pool[0];
    sl.spin = BOSS_RUSH.slotSpin;
    sl.spinTotal = BOSS_RUSH.slotSpin;
    sl.reelFrom = sl.reel;
    // enough turns that it reads as a spin, ending exactly on the result
    const idx = sl.pool.indexOf(sl.result);
    const laps = 4;
    sl.reelTo = Math.ceil(sl.reel / sl.pool.length) * sl.pool.length + laps * sl.pool.length + idx;
    Sfx.ui();
  }

  updatePerkSlot(dt) {
    const sl = this.perkSlot;
    if (!sl) { this.screen = 'modeSelect'; return; }
    sl.t += dt;
    if (sl.spin > 0) {
      sl.spin = Math.max(0, sl.spin - dt);
      const k = 1 - sl.spin / sl.spinTotal;
      const e = 1 - Math.pow(1 - k, 4);           // fast, then easing into place
      const prev = Math.floor(sl.reel);
      sl.reel = sl.reelFrom + (sl.reelTo - sl.reelFrom) * e;
      if (Math.floor(sl.reel) !== prev && sl.spin > 0.35) Sfx.ui();
      if (sl.spin <= 0) {
        sl.reel = sl.reelTo;
        sl.landed = sl.result;
        Camera.punch(0.8);
        Sfx.pickup();
      }
    }
  }

  takeSlotPerk() {
    const sl = this.perkSlot;
    if (!sl || !sl.landed) return;
    const id = sl.landed;
    this.perkSlot = null;
    this.startRun(this.weaponPick?.classId ?? 'melee', 'bossrush', this.rushWeapon, id);
  }

  quitToMenu() {
    this.closeCodex();
    resetCodex();
    this.screen = 'menu';
    this.player = null;
    clearFx();
  }

  // The generator a room's rewards come from: its own, derived from the seed,
  // for as long as the seed is meant to be in charge. `null` means "use the
  // loose one", which is what the last rooms want.
  roomRoll(tag, index = this.roomIndex) {
    if (this.mode === 'bossrush' || index > SEEDED_THROUGH_ROOM) return undefined;
    return streamFor(`${tag}:${index}`);
  }

  isBossRoom(index = this.roomIndex) {
    return this.mode === 'bossrush' ? true : index % BOSS_ROOM_INTERVAL === 0;
  }

  wavesInRoom(index = this.roomIndex) {
    // in a rush there is no trash to clear: the room is the boss
    if (this.mode === 'bossrush') return 1;
    return this.isBossRoom(index) ? WAVES.bossRoomWaves : WAVES.perRoom;
  }

  startRoom(index) {
    this.roomIndex = index;
    // Boss Rush is earned the moment both halves of the condition are true,
    // not at the end of the run - dying on room 19 should still count.
    if (this.mode === 'normal' && checkBossRushUnlock(index)) {
      this.toast('BOSS RUSH UNLOCKED');
    }
    this.roomCleared = false;
    this.portal = null;
    this.boss = null;
    this.cutscene.active = false;
    Camera.clearCinematic();
    this.pickups.length = 0;
    this.enemies.length = 0;
    this.projectiles.length = 0;
    this.shields.length = 0;
    // every second room comes with a forge, riding the drifting platform
    const drift = PLATFORMS.find((pl) => pl.tag === 'drift');
    this.anvil = (index % ANVIL.everyRooms === 0 && drift) ? new Anvil(drift) : null;
    this.forge = null;
    this.player.x = 120;
    this.player.y = GROUND_Y;
    this.player.vx = this.player.vy = 0;
    this.player.boomerangOut = null;
    this.player.releaseGrapple(true);
    this.player.resetChains();
    if (index > 1) this.player.healPct(1);
    // the Origamist restocks between rooms
    if (index > 1 && this.player.classId === 'origamist') {
      const got = this.givePaper(ORIGAMI.roomPaper);
      if (got > 0) floatText(this.player.x, this.player.cy - 20, `+${got} PAPER`, '#efeade', { life: 1.2 });
    }
    this.startWave(1);
  }

  startWave(n) {
    this.waveIndex = n;
    this.waveTimer = 0;
    this.waveCooldown = null;
    if (this.isBossRoom() && n === this.wavesInRoom()) {
      this.pendingSpawns = [];
      this.player.healPct(1);      // full HP going into the boss
      const rush = this.rushBossFor();
      this.boss = this.mode === 'bossrush'
        ? makeBoss(this, BOSS_RUSH.atRoom[rush] ?? 5, rush)
        : makeBoss(this, this.roomIndex);
      this.boss.intro = 99;        // held until the cutscene hands control back
      this.cutscene.play('intro', this.boss);
    } else {
      this.pendingSpawns = buildWave(this.roomIndex, n);
    }
    Sfx.wave();
  }

  onEnemyKilled(enemy) {
    this.kills++;
    if (enemy && !enemy.def.boss) this.rollPaperDrop(enemy);
  }

  // Called by a boss the moment its pool empties.
  onBossDefeated(boss) {
    if (this.screen !== 'playing') return;
    markBossDefeated(boss.def?.id);
    this.rollBossDrop(boss);
    this.cutscene.play('outro', boss);
  }

  onPlayerDeath() {
    // the bestiary goes with the run; the next one starts with a blank book
    resetCodex();
    this.screen = 'gameover';
    this.deathT = 0;
    this.captureRunStats();
  }

  captureRunStats() {
    const inv = this.player ? this.player.inventory : null;
    const held = [];
    if (inv) {
      for (const slot of inv.slots) {
        if (!slot) continue;
        const found = held.find((h) => h.id === slot.id);
        if (found) found.count += slot.count;
        else held.push({ id: slot.id, count: slot.count });
      }
    }
    this.runStats = {
      room: this.roomIndex,
      wave: this.waveIndex,
      waves: this.wavesInRoom(),
      kills: this.kills,
      time: this.runTime,
      seed: this.activeSeed || getSeed(),
      classId: this.player ? this.player.classId : 'melee',
      maxHp: this.player ? this.player.maxHp : 0,
      items: held,
    };
  }

  // --- time stop ---------------------------------------------------------

  // Everything but the god holds still: no movement, no attacks, no grapple.
  beginTimeStop(duration) {
    this.timeStopT = Math.max(this.timeStopT, duration);
    if (this.player) {
      this.player.vx = 0;
      this.player.vy = 0;
      this.player.releaseGrapple(true);
    }
  }

  endTimeStop() { this.timeStopT = 0; }

  get timeStopped() { return this.timeStopT > 0; }

  // --- the end -----------------------------------------------------------

  finishRun() {
    this.captureRunStats();
    this.runStats.room = this.lastRoom;
    this.runStats.mode = this.mode;
    this.screen = 'victory';
    this.victoryT = 0;
    this.boss = null;
    this.enemies.length = 0;
    this.projectiles.length = 0;
    this.timeStopT = 0;
    Camera.clearCinematic();
    Sfx.wave();
  }

  // Two shardgun splinters that meet burst into eight fragments each hitting
  // for three quarters of the gun's base damage. It is the gun's whole trick,
  // so it is worth a real bang.
  updateShardCollisions() {
    const list = [];
    for (const pr of this.projectiles) {
      if (!pr.dead && pr.kind === 'shard' && pr.shardPhase === 'splinter') list.push(pr);
    }
    if (list.length < 2) return;
    const r = SHARDGUN.collideRadius;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.dead) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.dead) continue;
        if (dist(a.x, a.y, b.x, b.y) > r * 2) continue;
        a.dead = true;
        b.dead = true;
        this.shardBurst((a.x + b.x) / 2, (a.y + b.y) / 2, a.baseDamage || SHARDGUN.damage, a.mark);
        break;
      }
    }
  }

  shardBurst(x, y, baseDamage, mark) {
    const C = SHARDGUN;
    const dmg = Math.max(1, Math.round(baseDamage * C.fragmentDamage));
    const off = rand(0, Math.PI * 2);
    for (let i = 0; i < C.fragments; i++) {
      const a = off + (i / C.fragments) * Math.PI * 2;
      const sp = C.fragmentSpeed * rand(0.85, 1.15);
      this.projectiles.push(new Projectile({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        damage: dmg, baseDamage, kind: 'shard', shardPhase: 'fragment',
        team: 'player', life: C.fragmentLife, mark, game: this,
      }));
    }
    Sfx.zap();
    Camera.add(6);
    Camera.punch(1.3);
    this.hitstop(0.045);
    screenFlash(0.18, '#c8b4ff', 0.14);
    impactRing(x, y, { color: '#ffffff', r0: 2, r1: 42, life: 0.3, width: 3 });
    impactRing(x, y, { color: SHARD_TINT, r0: 2, r1: 66, life: 0.45, width: 2 });
    burst(x, y, 26, {
      color: SHARD_TINT, color2: '#ffffff', speedMin: 60, speedMax: 260,
      lifeMin: 0.15, lifeMax: 0.5, sizeMax: 2, gravity: 0, drag: 0.88,
    });
    burst(x, y, 10, {
      color: '#ffffff', kind: 'streak', speedMin: 160, speedMax: 400,
      lifeMin: 0.06, lifeMax: 0.18, gravity: 0, drag: 0.8,
    });
  }

  // --- the bestiary --------------------------------------------------------
  // Openable any time, from the menu or mid-fight: it holds the world still
  // like the forge does, so reading it is never a way to dodge a hit.

  toggleCodex() { if (this.codex) this.closeCodex(); else this.openCodex(); }

  openCodex() {
    if (this.codex) return;
    const entries = CODEX_ORDER.map(codexEntry).filter(Boolean);
    // start on the first one you have not beaten yet - the page you want
    const first = entries.findIndex((e) => !e.beaten);
    this.codex = {
      t: 0, sel: first < 0 ? 0 : first, phase: 1, entries,
      preview: null, view: codexView(entries[0].id, 1), phaseRects: [], geom: codexLayout(),
    };
    this.buildCodexPreview();
    Sfx.ui();
  }

  closeCodex() {
    if (!this.codex) return;
    this.dropCodexPreview();
    this.codex = null;
    Sfx.ui();
  }

  // The preview is a whole boss, so it is built once per page turn and thrown
  // away on the next one rather than every frame.
  buildCodexPreview() {
    const c = this.codex;
    this.dropCodexPreview();
    const e = c.entries[c.sel];
    if (!e) return;
    const phase = e.twoPhases ? c.phase : 1;
    try {
      c.preview = makeBossPreview(this, e.id, phase);
    } catch (err) {
      // a page that cannot draw itself is not worth crashing the book over
      console.error('codex preview', err);
      c.preview = null;
    }
    c.view = codexView(e.id, phase);
  }

  dropCodexPreview() {
    const c = this.codex;
    if (!c || !c.preview) return;
    // belt and braces: the parts were spliced out when it was built, but a
    // stray reference left in the room would be a boss you cannot see
    for (const p of c.preview.previewParts ?? []) {
      const i = this.enemies.indexOf(p);
      if (i >= 0) this.enemies.splice(i, 1);
    }
    c.preview = null;
  }

  updateCodex(dt) {
    const c = this.codex;
    c.t += dt;
    const n = c.entries.length;
    const g = codexLayout();
    c.geom = g;

    // Escape and Tab are both handled in handleGlobalKeys, which runs first;
    // here only the right button closes it.
    if (Input.mouseDown.right) { this.closeCodex(); return; }
    let want = c.sel, phase = c.phase;
    if (Input.wheel !== 0) want = (want + sign(Input.wheel) + n) % n;
    if (Input.pressed.has(Binds.jump) || Input.pressed.has('ArrowUp')) want = (want - 1 + n) % n;
    if (Input.pressed.has(Binds.down) || Input.pressed.has('ArrowDown')) want = (want + 1) % n;
    if (Input.pressed.has(Binds.left) || Input.pressed.has('ArrowLeft')) phase = 1;
    if (Input.pressed.has(Binds.right) || Input.pressed.has('ArrowRight')) phase = 2;

    const cr = closeRect(g.x, g.y, g.w);
    c.closeHot = inRect(cr, Input.mouse.x, Input.mouse.y);
    if (c.closeHot && Input.mouseDown.left) { this.closeCodex(); return; }

    if (Input.mouseDown.left) {
      for (let i = 0; i < n; i++) {
        if (inRect(codexRowRect(g, i), Input.mouse.x, Input.mouse.y)) { want = i; break; }
      }
      for (let i = 0; i < c.phaseRects.length; i++) {
        if (inRect(c.phaseRects[i], Input.mouse.x, Input.mouse.y)) { phase = i + 1; break; }
      }
    }

    const entry = c.entries[want];
    phase = entry && entry.twoPhases ? clamp(phase, 1, 2) : 1;
    if (want !== c.sel || phase !== c.phase) {
      c.sel = want;
      c.phase = phase;
      this.buildCodexPreview();
      Sfx.ui();
    }
  }

  // --- setting things down -----------------------------------------------

  // The Gigantic Stinger Egg is not thrown, it is placed: you have to be
  // standing on the still platform in the middle of the room, and it goes down
  // on the boards under your feet.
  placeItem(def) {
    const p = this.player;
    if (!p || def.place !== 'giantegg') return;
    const pad = PLATFORMS.find((pl) => pl.tag === 'center');
    if (!pad) return;
    const onPad = p.onGround && Math.abs(p.y - pad.y) < 2 &&
      p.x > pad.x - 4 && p.x < pad.x + pad.w + 4;
    if (!onPad) { this.toast('STAND ON THE CENTRE PLATFORM'); Sfx.ui(); return; }
    if (this.boss && !this.boss.dead) { this.toast('SOMETHING IS ALREADY HERE'); Sfx.ui(); return; }
    if (!p.inventory.remove('giganticstingeregg', 1)) return;

    const e = new Enemy('giantstingeregg', clamp(p.x, pad.x + 10, pad.x + pad.w - 10), pad.y, this);
    e.spawnT = 0.3;
    this.enemies.push(e);
    Camera.add(8);
    Camera.punch(1.2);
    Sfx.slam();
    screenFlash(0.35, '#cdf3e6', 0.3);
    impactRing(e.cx, e.cy, { color: '#cdf3e6', r0: 4, r1: 90, life: 0.6, width: 3 });
    burst(e.cx, pad.y, 22, {
      color: '#cdf3e6', color2: '#ffffff', speedMin: 30, speedMax: 150,
      lifeMin: 0.25, lifeMax: 0.7, gravity: 200, angle: -Math.PI / 2, spread: 1.2,
    });
    p.recomputeStats();
  }

  // Five seconds later the shell comes apart and the thing inside gets its
  // own entrance, cutscene and all.
  hatchGiantEgg(egg) {
    const x = egg ? egg.cx : VIEW_W / 2;
    const y = egg ? egg.cy : 120;
    Camera.add(20);
    this.hitstop(0.22);
    screenFlash(0.85, '#ffffff', 0.55);
    Sfx.die();
    impactRing(x, y, { color: '#ffffff', r0: 6, r1: 200, life: 0.8, width: 4 });
    impactRing(x, y, { color: '#7ad7a0', r0: 4, r1: 130, life: 0.55, width: 3 });
    burst(x, y, 48, {
      color: '#cdf3e6', color2: '#ffffff', speedMin: 50, speedMax: 320,
      lifeMin: 0.3, lifeMax: 1.1, sizeMax: 4, gravity: 260, drag: 0.92,
    });
    if (this.boss && !this.boss.dead) return;
    this.boss = makeBoss(this, this.roomIndex, 'poitnus');
    this.boss.summoned = true;   // a room already has a boss; this one borrows the slot
    this.boss.x = clamp(x, 60, VIEW_W - 60);
    this.boss.targetX = this.boss.x;
    this.boss.y = Math.max(50, y - 20);
    this.boss.intro = 99;
    this.cutscene.play('intro', this.boss);
  }

  // --- the forge ---------------------------------------------------------

  // Melt a weapon down for bars, or spend bars and paper on armour. The world
  // stops while it is open, like the fold wheel.
  forgeRecipes() {
    const inv = this.player.inventory;
    const bars = inv.countOf('ironbar');
    const paper = inv.countOf('paper');
    const list = [];
    // smelting: one row per weapon you are actually carrying
    for (const id of ARMOR.smeltable) {
      if (!inv.has(id)) continue;
      list.push({
        kind: 'smelt', id, icon: id,
        label: `MELT ${ITEMS[id].name.toUpperCase()}`,
        cost: `-> ${ARMOR.smeltValue} BARS`,
        ok: true,
      });
    }
    // armour
    for (const [set, cost, unit, have] of [['iron', ARMOR.ironCost, 'BARS', bars],
                                           ['paper', ARMOR.paperCost, 'PAPER', paper]]) {
      for (const slot of ARMOR.slots) {
        const id = set + (slot === 'chest' ? 'chestplate' : slot === 'legs' ? 'leggings' : 'helmet');
        if (!ITEMS[id]) continue;
        const owned = inv.has(id) || inv.wornPieces().some((w) => w.id === id);
        list.push({
          kind: 'craft', id, icon: id, set,
          label: ITEMS[id].name.toUpperCase(),
          cost: owned ? 'OWNED' : `${cost} ${unit}`,
          ok: !owned && have >= cost,
          owned,
        });
      }
    }
    // Ammunition, and the cheapest thing on the list: a bar and a soul.
    {
      const bars2 = inv.countOf('ironbar');
      const souls2 = inv.countOf('soul');
      const needB = Math.max(0, SOUL_DART.barCost - bars2);
      const needS = Math.max(0, SOUL_DART.soulCost - souls2);
      list.push({
        kind: 'souldart', id: 'souldart', icon: 'souldart',
        label: `${SOUL_DART.perCraft}x SOUL DART`,
        cost: needB || needS ? `${SOUL_DART.barCost} BAR ${SOUL_DART.soulCost} SOUL` : 'READY',
        ok: !needB && !needS,
      });
    }
    // The one recipe that is not armour: shells and souls into the egg.
    {
      const shells = inv.countOf('stingereggshell');
      const souls = inv.countOf('soul');
      const owned = inv.has('giganticstingeregg');
      const needS = Math.max(0, GIANT_EGG.shells - shells);
      const needL = Math.max(0, GIANT_EGG.souls - souls);
      // the running tally lives in the header, so the row only has to say
      // what is still missing - which is the part you can act on
      const cost = owned ? 'CARRIED'
        : needS && needL ? `NEED ${needS}+${needL}`
          : needS ? `NEED ${needS} SHELL`
            : needL ? `NEED ${needL} SOUL` : 'READY';
      list.push({
        kind: 'giantegg', id: 'giganticstingeregg', icon: 'giganticstingeregg',
        label: 'GIGANTIC STINGER EGG', cost,
        ok: !owned && !needS && !needL,
        owned,
      });
    }
    return list;
  }

  openForge() {
    if (!this.player || this.forge) return;
    this.forge = { sel: 0, scroll: 0, t: 0, list: this.forgeRecipes(), drag: null };
    Sfx.ui();
  }

  closeForge() {
    if (!this.forge) return;
    this.forge = null;
    Sfx.ui();
  }

  updateForge(dt) {
    const f = this.forge;
    f.t += dt;
    f.list = this.forgeRecipes();
    const n = f.list.length;
    if (n === 0) { if (Input.mouseDown.right || Input.pressed.has('Escape')) this.closeForge(); return; }
    const g = forgeLayout(n);
    f.geom = g;
    const maxScroll = Math.max(0, n - g.visible);
    f.sel = clamp(f.sel, 0, n - 1);

    // Wheel and keys move the SELECTION, and the view chases it. A drag moves
    // the VIEW, and the selection stays where it is - otherwise letting go of
    // a scroll would snap the list straight back to the highlighted row.
    let seek = false;
    if (Input.wheel !== 0) {
      f.sel = (f.sel + sign(Input.wheel) + n) % n;
      seek = true;
      Sfx.ui();
    }
    if (Input.pressed.has(Binds.jump) || Input.pressed.has('ArrowUp')) { f.sel = (f.sel - 1 + n) % n; seek = true; Sfx.ui(); }
    if (Input.pressed.has(Binds.down) || Input.pressed.has('ArrowDown')) { f.sel = (f.sel + 1) % n; seek = true; Sfx.ui(); }
    if (Input.pressed.has('Escape') || Input.mouseDown.right) { this.closeForge(); return; }

    // --- dragging the list. A press inside the rows starts a candidate drag;
    // it only becomes a scroll once the finger has actually moved, so a tap
    // still reads as a tap and never scrolls the row out from under itself.
    const onList = inRect(forgeListRect(g), Input.mouse.x, Input.mouse.y);
    if (Input.mouseDown.left && onList) {
      f.drag = { y0: Input.mouse.y, scroll0: f.scroll, moved: 0 };
    }
    if (f.drag && Input.mouse.left) {
      const dy = Input.mouse.y - f.drag.y0;
      f.drag.moved = Math.max(f.drag.moved, Math.abs(dy));
      if (f.drag.moved > 3) f.scroll = clamp(f.drag.scroll0 - dy / g.rowH, 0, maxScroll);
    }
    const dragged = f.drag && f.drag.moved > 3;
    const released = f.drag && !Input.mouse.left;
    if (released) f.drag = null;

    // the selection drags the view along with it when it leaves the window
    if (seek) f.scroll = clamp(f.scroll, f.sel - g.visible + 1, f.sel);
    f.scroll = clamp(f.scroll, 0, maxScroll);
    const top = Math.round(f.scroll);

    // Work out what the cursor is over NOW. Reading a hover that was worked
    // out while drawing is a frame behind, and a touch arrives and clicks in
    // the same frame - which is how tapping one recipe used to forge another.
    let over = -1;
    for (let i = 0; i < g.visible; i++) {
      const idx = top + i;
      if (idx >= n) break;
      if (inRect(forgeRowRect(g, i), Input.mouse.x, Input.mouse.y)) { over = idx; break; }
    }
    f.hover = over;
    f.top = top;
    if (over >= 0 && !dragged) f.sel = over;

    const cr = closeRect(g.x, g.y, g.w);
    f.closeHot = inRect(cr, Input.mouse.x, Input.mouse.y);
    if (f.closeHot && Input.mouseDown.left) { this.closeForge(); return; }
    // Only a tap that both starts and ends on a recipe forges it: a stray tap
    // on the panel can never spend your bars, and neither can a scroll that
    // happened to begin on a row.
    if (f.t > 0.12 && released && !dragged && over >= 0) this.craft(f.list[over]);
  }

  craft(entry) {
    const p = this.player;
    const inv = p.inventory;
    if (!entry) return;
    if (entry.kind === 'souldart') {
      if (!entry.ok) { Sfx.ui(); return; }
      if (inv.countOf('ironbar') < SOUL_DART.barCost) return;
      if (inv.countOf('soul') < SOUL_DART.soulCost) return;
      inv.remove('ironbar', SOUL_DART.barCost);
      inv.remove('soul', SOUL_DART.soulCost);
      const left = inv.add('souldart', SOUL_DART.perCraft);
      if (left >= SOUL_DART.perCraft) {
        // nothing fitted: hand the materials back rather than eating them
        inv.add('ironbar', SOUL_DART.barCost);
        inv.add('soul', SOUL_DART.soulCost);
        this.toast('NO ROOM FOR IT');
        Sfx.ui();
        return;
      }
      const made = SOUL_DART.perCraft - left;
      floatText(this.anvil ? this.anvil.x : p.x, (this.anvil ? this.anvil.y : p.cy) - 22,
                `+${made} SOUL DART`, '#7cc8ff', { life: 1.2 });
      this.forgeSparks('#7cc8ff');
      p.recomputeStats();
      Sfx.pickup();
      return;
    }
    if (entry.kind === 'giantegg') {
      if (!entry.ok) { Sfx.ui(); return; }
      if (inv.countOf('stingereggshell') < GIANT_EGG.shells) return;
      if (inv.countOf('soul') < GIANT_EGG.souls) return;
      inv.remove('stingereggshell', GIANT_EGG.shells);
      inv.remove('soul', GIANT_EGG.souls);
      if (inv.add('giganticstingeregg', 1) > 0) {
        // no room: hand the parts straight back rather than eating them
        inv.add('stingereggshell', GIANT_EGG.shells);
        inv.add('soul', GIANT_EGG.souls);
        this.toast('NO ROOM FOR IT');
        Sfx.ui();
        return;
      }
      floatText(this.anvil ? this.anvil.x : p.x, (this.anvil ? this.anvil.y : p.cy) - 22,
                'GIGANTIC STINGER EGG', '#cdf3e6', { life: 1.4 });
      this.forgeSparks('#cdf3e6');
      p.recomputeStats();
      Sfx.pickup();
      return;
    }
    if (entry.kind === 'smelt') {
      if (!inv.remove(entry.id, 1)) return;
      inv.add('ironbar', ARMOR.smeltValue);
      floatText(this.anvil ? this.anvil.x : p.x, (this.anvil ? this.anvil.y : p.cy) - 22,
                `+${ARMOR.smeltValue} BARS`, '#ccd6e6', { life: 1.0 });
      this.forgeSparks('#ffb43c');
    } else {
      if (!entry.ok) { Sfx.ui(); return; }
      const set = entry.set;
      const cost = set === 'iron' ? ARMOR.ironCost : ARMOR.paperCost;
      const mat = set === 'iron' ? 'ironbar' : 'paper';
      if (!inv.remove(mat, cost)) return;
      if (inv.add(entry.id, 1) > 0) { inv.add(mat, cost); Sfx.ui(); return; }   // no room
      floatText(this.anvil ? this.anvil.x : p.x, (this.anvil ? this.anvil.y : p.cy) - 22,
                ITEMS[entry.id].name.toUpperCase(), set === 'iron' ? '#ccd6e6' : INK.paper, { life: 1.2 });
      this.forgeSparks(set === 'iron' ? '#ccd6e6' : INK.paper);
    }
    p.recomputeStats();
    Sfx.pickup();
  }

  forgeSparks(color) {
    const a = this.anvil;
    if (!a) return;
    Camera.add(4);
    Camera.punch(0.6);
    impactRing(a.x, a.y - 10, { color, r0: 2, r1: 40, life: 0.35, width: 2 });
    burst(a.x, a.y - 10, 22, {
      color, color2: '#fff0a0', speedMin: 40, speedMax: 220,
      lifeMin: 0.15, lifeMax: 0.55, gravity: 320, drag: 0.9, kind: 'streak',
    });
  }

  // --- origami -----------------------------------------------------------

  // Attacking with paper stops the world and asks which fold you want. Only
  // folds you own the tutor book for are on the wheel.
  openFoldWheel() {
    const p = this.player;
    if (!p || this.fold) return;
    if (p.attackCd > 0) return;              // folds have their own cadence
    if (p.attackCd > 0) return;              // folds have their own cadence
    const known = p.inventory.knownFolds();
    // the Paper set teaches a fold no book does
    if (p.armorSet === 'paper' && !known.includes('shield')) known.push('shield');
    if (!known.length) return;
    const options = known.map((id) => {
      const cfg = ORIGAMI.forms[id];
      return { id, name: cfg.name, cost: cfg.cost };
    });
    // rot is where the ring is; targetRot is where it is heading. Scrolling
    // adds a full slice to the target, so it always spins the way you scrolled.
    this.fold = { options, sel: 0, t: 0, aim: p.aim, rot: 0, targetRot: 0, spin: 0,
                  hold: null, holdK: 0, close: null, closeHot: false, touchHint: false };
    Sfx.ui();
  }

  // Nothing moves while it is open: mouse angle picks the slice, left click or
  // a number key commits, right click or Escape backs out.
  updateFoldWheel(dt) {
    const f = this.fold;
    f.t += dt;
    const n = f.options.length;
    const step = TAU / n;

    // scroll cycles the folds; the ring chases the new angle instead of jumping
    if (Input.wheel !== 0 && n > 1) {
      const dir = sign(Input.wheel);
      f.sel = (f.sel + dir + n) % n;
      f.targetRot -= dir * step;
      f.spin = 1;
      Sfx.ui();
      Camera.punch(0.18);
    }
    // a springy ease so the ring overshoots a touch and settles
    f.rot = lerp(f.rot, f.targetRot, 1 - Math.pow(0.00004, dt));
    f.spin = Math.max(0, f.spin - dt * 3.4);

    for (let i = 0; i < n && i < 9; i++) {
      if (Input.pressed.has(String(i + 1))) {
        f.sel = i;
        this.chooseFold(f.options[i].id);
        return;
      }
    }
    if (Input.pressed.has('Escape') || Input.mouseDown.right) { this.closeFoldWheel(); return; }

    // The wheel sits over the player, so its close button has to be worked out
    // from the same projection the drawing uses. Doing it here means update and
    // draw agree, and a tap is matched against where the button really is.
    const scr = Camera.project(this.player.x, this.player.cy - 44);
    const wx = Math.round(clamp(scr.x, 60, VIEW_W - 60));
    const wy = Math.round(clamp(scr.y, 52, VIEW_H - 66));
    const cr = { x: clamp(wx + 46, 4, VIEW_W - 16), y: clamp(wy - 54, 4, VIEW_H - 16), w: 12, h: 12 };
    f.close = cr;
    f.closeHot = inRect(cr, Input.mouse.x, Input.mouse.y);
    if (f.closeHot && Input.mouseDown.left) { this.closeFoldWheel(); return; }

    // On touch there is no wheel to spin and no number row to press, and a tap
    // that committed the moment it landed would pick whatever happened to be
    // at the top. So: drag up or down to turn the wheel, then hold still to
    // commit. Browsing restarts the timer, so you can look before you fold.
    f.touchHint = Options.mobileControls || Input.touchSeen;
    if (f.touchHint) {
      if (Input.mouseDown.left && !f.closeHot) f.hold = { y: Input.mouse.y, t: 0 };
      if (f.hold && Input.mouse.left) {
        f.hold.t += dt;
        const dy = Input.mouse.y - f.hold.y;
        if (n > 1 && Math.abs(dy) >= FOLD_DRAG_STEP) {
          const dir = dy > 0 ? 1 : -1;
          f.sel = (f.sel + dir + n) % n;
          f.targetRot -= dir * step;
          f.spin = 1;
          f.hold.y += dir * FOLD_DRAG_STEP;   // rebase so a long drag keeps stepping
          f.hold.t = 0;
          Sfx.ui();
          Camera.punch(0.18);
        }
        f.holdK = clamp(f.hold.t / FOLD_HOLD_TIME, 0, 1);
        if (f.hold.t >= FOLD_HOLD_TIME) { this.chooseFold(f.options[f.sel].id); return; }
      } else {
        f.holdK = 0;
      }
      if (Input.mouseUp.left) { f.hold = null; f.holdK = 0; }
    } else if (f.t > 0.12 && Input.mouseDown.left) {
      this.chooseFold(f.options[f.sel].id);
    }
  }

  closeFoldWheel() {
    if (!this.fold) return;
    this.fold = null;
    Sfx.ui();
  }

  // Commit to a fold: spend the sheets and throw it.
  chooseFold(id) {
    const p = this.player;
    const cfg = ORIGAMI.forms[id];
    const aim = this.fold ? this.fold.aim : p.aim;
    this.fold = null;
    if (!cfg || !p) return;
    if (id === 'shield' && this.shields.length) {
      Sfx.ui();
      floatText(p.x, p.cy - 14, 'SHIELDS STILL UP', Theme.uiDim, { life: 0.8 });
      return;
    }
    if (!p.inventory.remove('paper', cfg.cost)) {
      Sfx.ui();
      floatText(p.x, p.cy - 14, 'NO PAPER', Theme.uiDim, { life: 0.7 });
      return;
    }
    p.recomputeStats();
    p.attackCd = (cfg.cooldown ?? ORIGAMI.cooldown) * (1 + (p.armorBuff?.foldCooldown ?? 0));
    p.swing = { t: 0, angle: aim, kind: 'throw' };
    if (id === 'shield') { this.raisePaperShields(); return; }
    const ox = p.x + Math.cos(aim) * 9, oy = p.cy + Math.sin(aim) * 9;
    // paper leggings push the plane along faster
    const speed = cfg.speed * (id === 'airplane' ? 1 + (p.armorBuff?.planeSpeed ?? 0) : 1);
    this.projectiles.push(new Projectile({
      x: ox, y: oy,
      vx: Math.cos(aim) * speed, vy: Math.sin(aim) * speed,
      damage: Math.round(p.boosted(cfg.damage, 'paper') * (1 + (p.armorBuff?.origamiDamage ?? 0))),
      kind: 'origami', fold: id, team: 'player',
      life: id === 'missile' ? 6 : 14, game: this,
    }));
    Sfx.swing();
    Camera.add(id === 'missile' ? 5 : 2.2);
    Camera.punch(id === 'missile' ? 0.7 : 0.3);
    // the fold itself unfurling: a flat ring along the throw, plus creases
    impactRing(ox, oy, {
      color: INK.paper, r0: 1, r1: 26, life: 0.2, width: 1.6,
      squash: 0.35, rotate: aim,
    });
    impactRing(ox, oy, {
      color: INK.ink, r0: 2, r1: 44, life: 0.34, width: 1.2,
      squash: 0.28, rotate: aim,
    });
    burst(ox, oy, id === 'missile' ? 20 : 12, {
      color: INK.ink, color2: INK.paper,
      kind: 'streak', speedMin: 70, speedMax: 250, lifeMin: 0.07, lifeMax: 0.22,
      gravity: 0, angle: aim, spread: 0.55, drag: 0.84, glow: false,
    });
    // scraps of the sheet spinning off the hand
    burst(ox, oy, id === 'missile' ? 10 : 6, {
      color: INK.paper, color2: INK.paperShade, speedMin: 30, speedMax: 130,
      lifeMin: 0.3, lifeMax: 0.8, sizeMin: 1, sizeMax: 2, gravity: 260, drag: 0.9,
      angle: aim, spread: 1.5, glow: false,
    });
    if (id === 'missile') {
      burst(ox, oy, 8, {
        color: INK.inkSoft, kind: 'smoke', speedMin: 16, speedMax: 70,
        lifeMin: 0.3, lifeMax: 0.8, sizeMin: 1, sizeMax: 3, gravity: -30,
        angle: aim + Math.PI, spread: 0.8, glow: false,
      });
    }
  }

  // Three plates that orbit you for a minute and a half, cutting whatever they
  // pass through. Only one set can be up at a time.
  raisePaperShields() {
    const p = this.player;
    for (let i = 0; i < PAPER_SHIELD.count; i++) {
      this.shields.push({ a: (i / PAPER_SHIELD.count) * TAU, t: 0, hits: new Map(), pop: 0 });
    }
    Sfx.pickup();
    Camera.add(6);
    impactRing(p.x, p.cy, { color: INK.paper, r0: 4, r1: PAPER_SHIELD.radius * 2.4, life: 0.5, width: 2 });
    impactRing(p.x, p.cy, { color: INK.ink, r0: 2, r1: PAPER_SHIELD.radius * 1.6, life: 0.35, width: 1.5 });
    burst(p.x, p.cy, 26, {
      color: INK.paper, color2: INK.ink, speedMin: 40, speedMax: 190,
      lifeMin: 0.2, lifeMax: 0.7, gravity: 60, drag: 0.9, glow: false,
    });
  }

  updatePaperShields(dt) {
    if (!this.shields.length) return;
    const p = this.player;
    const C = PAPER_SHIELD;
    for (let i = this.shields.length - 1; i >= 0; i--) {
      const sh = this.shields[i];
      sh.t += dt;
      sh.a += C.spin * dt;
      sh.pop = Math.min(1, sh.pop + dt * 5);
      if (sh.t >= C.life) {
        this.shields.splice(i, 1);
        burst(p.x + Math.cos(sh.a) * C.radius, p.cy + Math.sin(sh.a) * C.radius * 0.75, 12, {
          color: INK.paper, color2: INK.paperShade, speedMin: 20, speedMax: 110,
          lifeMin: 0.3, lifeMax: 0.9, gravity: 300, drag: 0.9, glow: false,
        });
        continue;
      }
      const sx = p.x + Math.cos(sh.a) * C.radius;
      const sy = p.cy + Math.sin(sh.a) * C.radius * 0.75;
      sh.x = sx; sh.y = sy;
      // decay the per-enemy cooldowns
      for (const [uid, tt] of sh.hits) {
        if (tt - dt <= 0) sh.hits.delete(uid); else sh.hits.set(uid, tt - dt);
      }
      for (const e of this.enemies) {
        if (e.dead || e.spawnT > 0 || e.untargetable) continue;
        if (sh.hits.has(e.uid)) continue;
        if (Math.abs(sx - e.cx) > e.w / 2 + 6 || Math.abs(sy - e.cy) > e.h / 2 + 6) continue;
        sh.hits.set(e.uid, C.hitCooldown);
        e.damage(p.boosted(C.damage, 'paper'), {
          color: INK.ink, knockback: 60, fromX: p.x, shake: 0,
        });
        burst(sx, sy, 10, {
          color: INK.ink, color2: INK.paper, speedMin: 30, speedMax: 140,
          lifeMin: 0.12, lifeMax: 0.4, gravity: 120, drag: 0.88, glow: false,
        });
      }
      if (Math.random() < dt * 8) {
        spawnParticle({
          x: sx, y: sy, vx: rand(-8, 8), vy: rand(-8, 8), life: rand(0.2, 0.5),
          size: 1, color: Math.random() < 0.4 ? INK.ink : INK.paper,
          gravity: 40, drag: 0.94, kind: 'shrink', glow: false,
        });
      }
    }
  }

  drawPaperShields(ctx) {
    const C = PAPER_SHIELD;
    for (const sh of this.shields) {
      if (sh.x === undefined) continue;
      const fade = clamp((C.life - sh.t) / 6, 0, 1);      // they thin out at the end
      const cel = Math.floor(sh.t * 12);
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(Math.round(sh.x), Math.round(sh.y));
      ctx.rotate(sh.a * 0.6);
      ctx.scale(sh.pop, sh.pop);
      doodleShape(ctx, [[0, -7], [6, -2], [4, 7], [-4, 7], [-6, -2]],
                  INK.paper, INK.ink, 1.2, cel, 1.0);
      doodleLine(ctx, [[0, -5], [0, 5]], INK.inkSoft, 1, cel + 1, 0.8);
      doodleLine(ctx, [[-3, 0], [3, 0]], INK.inkSoft, 1, cel + 2, 0.8);
      ctx.restore();
    }
  }

  // The missile going off: five blocks of paper fire.
  // (a small helper so the launch reads hot without repeating four calls)
  paperBlast(x, y, damage) {
    const cfg = ORIGAMI.forms.missile;
    const r = cfg.blastRadius;
    for (const e of this.enemies) {
      if (e.dead || e.spawnT > 0 || e.untargetable) continue;
      const d = dist(e.cx, e.cy, x, y);
      if (d > r + e.radius) continue;
      // full damage at the core, tapering to two thirds at the rim
      const k = 1 - 0.34 * clamp(d / r, 0, 1);
      e.damage(Math.max(1, Math.round(damage * k)), {
        color: INK.ink, crit: d < r * 0.4, knockback: 150, fromX: x, shake: 0,
      });
    }
    Sfx.slam();
    Camera.add(13);
    Camera.punch(2.4);
    this.hitstop(0.07);
    screenFlash(0.30, '#ffffff', 0.18);
    // an ink splat over a burst of shredded paper
    impactRing(x, y, { color: INK.paper, r0: 4, r1: r * 1.1, life: 0.3, width: 4 });
    impactRing(x, y, { color: INK.ink, r0: 3, r1: r * 1.5, life: 0.5, width: 3 });
    impactRing(x, y, { color: INK.ink, r0: 2, r1: r * 1.9, life: 0.75, width: 1.5 });
    burst(x, y, 38, {
      color: INK.ink, color2: INK.inkSoft, speedMin: 50, speedMax: 330,
      lifeMin: 0.2, lifeMax: 0.9, sizeMax: 3, gravity: 210, drag: 0.9, glow: false,
    });
    burst(x, y, 26, {
      color: INK.paper, color2: INK.paperShade, speedMin: 30, speedMax: 210,
      lifeMin: 0.4, lifeMax: 1.4, sizeMax: 2, gravity: 300, drag: 0.92, glow: false,
    });
    burst(x, y, 12, {
      color: INK.inkSoft, kind: 'smoke', speedMin: 20, speedMax: 110,
      lifeMin: 0.5, lifeMax: 1.4, sizeMin: 2, sizeMax: 5, gravity: -50, drag: 0.9, glow: false,
    });
    burst(x, y, 16, {
      color: INK.ink, kind: 'streak', speedMin: 180, speedMax: 440,
      lifeMin: 0.07, lifeMax: 0.22, gravity: 0, drag: 0.8, glow: false,
    });
  }

  // Hand over paper, never past the carry limit. Returns what was actually
  // given, so the float text does not promise sheets that never arrived.
  givePaper(n) {
    const inv = this.player?.inventory;
    if (!inv) return 0;
    const room = Math.max(0, ORIGAMI.maxPaper - inv.countOf('paper'));
    const give = Math.min(n, room);
    if (give > 0) inv.add('paper', give);
    return give;
  }

  // Paper the Origamist tears off a body. It flies to the hand on its own.
  rollPaperDrop(enemy) {
    const p = this.player;
    if (!p || p.classId !== 'origamist') return;
    if (Math.random() >= ORIGAMI.dropChance) return;
    const n = this.givePaper(randInt(ORIGAMI.dropMin, ORIGAMI.dropMax));
    if (n <= 0) return;
    floatText(enemy.cx, enemy.cy - 10, `+${n} PAPER`, '#efeade', { life: 0.9 });
    Sfx.pickup();
    for (let i = 0; i < n * 4; i++) {
      const a = rand(0, Math.PI * 2);
      spawnParticle({
        x: enemy.cx, y: enemy.cy, vx: Math.cos(a) * rand(40, 150), vy: Math.sin(a) * rand(40, 150) - 40,
        life: rand(0.3, 0.8), size: randInt(1, 2), color: '#efeade',
        gravity: 220, drag: 0.9, kind: 'shrink',
      });
    }
    impactRing(enemy.cx, enemy.cy, { color: '#efeade', r0: 2, r1: 30, life: 0.3, width: 1.5 });
  }

  // A regular enemy leaving a weapon behind: it drops where the body broke and
  // falls to whatever is under it, ready to be picked up.
  rollEnemyDrop(enemy) {
    this.rollWeaponDrop(enemy.def.dropId, enemy.def.dropChance ?? 0.1, enemy.cx, enemy.cy);
  }

  // Every boss leaves souls behind - except the god, which has none to give.
  rollBossDrop(boss) {
    if (!boss) return;
    // Poitnus leaves its own weapon: the trident to someone who fights up
    // close, the gun to everyone else, since a Stident in an Origamist's bag
    // is a rock they cannot swing.
    if (boss.def.id === 'poitnus' && this.player) {
      const inv = this.player.inventory;
      const first = this.player.classId === 'melee' ? 'stident' : 'stingergun';
      const other = first === 'stident' ? 'stingergun' : 'stident';
      // A ranger who walked in already holding a Stinger Gun still earned
      // something, so the other half of the hoard falls instead. Only when
      // both are already in the bag does the kill leave no weapon.
      const id = !inv.has(first) ? first : (!inv.has(other) ? other : null);
      if (id) {
        const x = clamp(boss.x ?? VIEW_W / 2, 24, VIEW_W - 24);
        const y = clamp((boss.y ?? 100) + 20, 30, GROUND_Y - 20);
        // A rush clears the floor the moment the spoils screen closes, so a
        // dropped weapon would be swept up unheld. It goes straight in.
        if (this.mode === 'bossrush') {
          if (inv.add(id, 1) === 0) {
            this.player.recomputeStats();
            this.toast(`${ITEMS[id].name.toUpperCase()} TAKEN`);
          }
        } else {
          this.pickups.push(new Pickup(id, x, y, null, { falling: true, vy: -140 }));
          this.toast(`${ITEMS[id].name.toUpperCase()} DROPPED`);
        }
        burst(x, y, 26, {
          color: RARITY[ITEMS[id].rarity].color, color2: '#ffffff',
          speedMin: 30, speedMax: 150, lifeMin: 0.3, lifeMax: 0.8, gravity: 140,
        });
      }
    }
    if (boss.def.id === 'alphads') return;
    const [lo, hi] = DROPS.soulsPerBoss;
    const x = clamp(boss.x ?? boss.hx ?? VIEW_W / 2, 24, VIEW_W - 24);
    const y = clamp(boss.y ?? boss.hy ?? GROUND_Y - 40, 30, GROUND_Y - 20);
    const roll = this.roomRoll('bossdrop');
    const n = roll ? lo + Math.floor(roll() * (hi - lo + 1)) : randInt(lo, hi);
    this.dropItems('soul', n, x, y);
  }

  // A handful of the same thing thrown out of one point. Each lands on its
  // own, so a pile of five reads as five things and not as one.
  dropItems(id, n, x, y) {
    if (!ITEMS[id]) return 0;
    for (let i = 0; i < n; i++) {
      this.pickups.push(new Pickup(id, clamp(x + rand(-8, 8), 10, VIEW_W - 10), y, null, {
        falling: true, vx: rand(-70, 70), vy: rand(-190, -110),
      }));
    }
    return n;
  }

  rollWeaponDrop(id, chance, x, y) {
    if (!id || !ITEMS[id]) return;
    if (this.player && this.player.inventory.has(id)) return;   // one is enough
    if (Math.random() >= chance) return;
    const pk = new Pickup(id, x, y, null, {
      falling: true, vx: rand(-40, 40), vy: rand(-150, -70),
    });
    this.pickups.push(pk);
    const col = RARITY[ITEMS[id].rarity].color;
    burst(x, y, 22, {
      color: col, color2: '#ffffff', speedMin: 40, speedMax: 190,
      lifeMin: 0.25, lifeMax: 0.7, sizeMax: 3, gravity: 180, drag: 0.9,
    });
    impactRing(x, y, { color: col, r0: 2, r1: 46, life: 0.45, width: 2 });
    Sfx.pickup();
  }

  nearestEnemy(x, y) {
    let best = null, bd = Infinity;
    for (const e of this.enemies) {
      if (e.dead || e.spawnT > 0) continue;
      const d = dist(x, y, e.cx, e.cy);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  // Every third contact detonates properly instead of popping.
  nukerangBlast(x, y, owner) {
    if (owner) owner.nukeBlasts = (owner.nukeBlasts ?? 0) + 1;
    const big = owner ? owner.nukeBlasts % NUKERANG.bigEvery === 0 : false;
    const radius = big ? NUKERANG.bigRadius : NUKERANG.hitRadius;
    let damage = big ? NUKERANG.bigDamage : NUKERANG.hitDamage;
    if (this.player) damage = this.player.boosted(damage, 'boomerang');
    const col = big ? Theme.fireHot : Theme.fire;

    for (const e of this.enemies) {
      if (e.dead || e.spawnT > 0 || e.untargetable) continue;
      if (dist(e.cx, e.cy, x, y) > radius + e.radius) continue;
      e.damage(damage, {
        color: col, crit: big, knockback: big ? 150 : 60, fromX: x, shake: 0,
      });
    }

    Sfx.slam();
    Camera.add(big ? 11 : 3.5);
    Camera.punch(big ? 2.4 : 0.8);
    if (big) { this.hitstop(0.07); screenFlash(0.26, '#ffc08a', 0.18); }
    impactRing(x, y, { color: '#ffffff', r0: 3, r1: radius * (big ? 1.5 : 1.2), life: big ? 0.38 : 0.24, width: big ? 3 : 2 });
    impactRing(x, y, { color: col, r0: 2, r1: radius * (big ? 2.1 : 1.5), life: big ? 0.5 : 0.32, width: big ? 2.5 : 1.5 });
    burst(x, y, big ? 34 : 14, {
      color: col, color2: big ? Theme.fire : Theme.spark, speedMin: 40, speedMax: big ? 280 : 150,
      lifeMin: 0.2, lifeMax: big ? 0.8 : 0.5, sizeMax: big ? 3 : 2, gravity: 200, drag: 0.9,
    });
    burst(x, y, big ? 14 : 6, {
      color: '#3a2a1a', kind: 'smoke', speedMin: 15, speedMax: big ? 90 : 50,
      lifeMin: 0.4, lifeMax: big ? 1.1 : 0.7, sizeMin: 2, sizeMax: big ? 5 : 3,
      gravity: -40, drag: 0.9, glow: false,
    });
    if (big) {
      burst(x, y, 12, {
        color: '#ffffff', color2: col, kind: 'streak', speedMin: 160, speedMax: 360,
        lifeMin: 0.12, lifeMax: 0.3, gravity: 0, drag: 0.86,
      });
    }
  }

  chainLightning(a, b) {
    const pts = boltPath(a.cx, a.cy, b.cx, b.cy, 7, 10, Math.random() * 10);
    this.bolts.push({ pts, t: 0, life: 0.3 });
    Sfx.zap();
    Camera.add(3);
    impactRing(a.cx, a.cy, { color: Theme.lightning, r1: 24, life: 0.3, width: 2 });
    impactRing(b.cx, b.cy, { color: Theme.lightning, r1: 24, life: 0.3, width: 2 });
    Camera.punch(0.8);
    for (const e of [a, b]) {
      if (e.immuneLightning) continue;
      e.damage(PERK.chainDamage, { color: Theme.lightning, shake: 0 });
      if (!e.dead) e.applyElectrified();
    }
    // anything caught by the arc itself
    for (const e of this.enemies) {
      if (e.dead || e === a || e === b || e.spawnT > 0 || e.immuneLightning) continue;
      if (distToSegment(e.cx, e.cy, a.cx, a.cy, b.cx, b.cy) < e.radius + 6) {
        e.damage(PERK.chainDamage, { color: Theme.lightning, shake: 0 });
        if (!e.dead) e.applyElectrified();
      }
    }
    for (let i = 0; i < 14; i++) {
      const t = Math.random();
      spawnParticle({
        x: lerp(a.cx, b.cx, t), y: lerp(a.cy, b.cy, t),
        vx: rand(-70, 70), vy: rand(-70, 70), life: rand(0.15, 0.35),
        size: 1, color: Theme.lightning, gravity: 0, kind: 'line',
      });
    }
  }

  // --- update ------------------------------------------------------------

  loop(now) {
    const workStart = performance.now();
    let dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    inputTick(dt);
    if (Input.touchSeen && !this.touchHinted) {
      this.touchHinted = true;
      if (!Options.mobileControls) this.toast('TOUCH DETECTED - TURN ON THE PAD IN SETTINGS');
    }
    uiBeginFrame(dt);
    this.time += dt;
    if (this.hintT > 0) this.hintT -= dt;
    if (this.screen === 'victory') this.victoryT += dt;

    let gdt = dt;
    if (this.freezeT > 0) {
      this.freezeT -= dt;
      gdt = dt * 0.08;
    }
    this.postfx.slowmo = lerp(this.postfx.slowmo, this.freezeT > 0 ? 1 : 0, 1 - Math.pow(0.001, dt));
    this.postfx.grain = Options.grain;
    this.postfx.halation = Options.halation;
    // the world drains of colour while the god holds it still
    this.postfx.timeStop = lerp(this.postfx.timeStop, this.timeStopT > 0 ? 1 : 0, 1 - Math.pow(1e-6, dt));

    // One bad frame must never end the run: log it and keep the loop alive.
    try {
      // the pad turns fingers into keys and cursor before anything reads them
      updateTouchPad(this, dt);
      // watch real frame times and give back quality if this device needs it
      const tier = perfTick(dt, this.workMs ?? 0);
      if (tier !== null) {
        this.resize();
        this.toast(`GRAPHICS: ${TIERS[tier].name}`);
      }
      this.handleGlobalKeys();
      // The bestiary is readable from anywhere, including the menu, so it is
      // driven here rather than from update() - which only runs while a run
      // is actually in progress.
      if (this.codex) {
        this.updateCodex(dt);
        updateWorld(dt, true);
      } else if (this.screen === 'perkSlot') {
        this.updatePerkSlot(dt);
        updateWorld(dt, true);
      } else if (this.screen === 'rushReward') {
        this.updateRushReward(dt);
        updateWorld(dt, true);
      } else if (this.debugOpen) {
        updateWorld(dt, true);
      } else if (this.screen === 'playing' || this.screen === 'gameover') {
        this.update(gdt);
      } else {
        updateWorld(dt, true);
      }

      updateFx(this.screen === 'playing' || this.screen === 'gameover' ? gdt : dt);
      Camera.update(this.screenShake ? dt : 0);
      if (!this.screenShake) { Camera.ox = 0; Camera.oy = 0; }

      this.render(dt);
      this.present(dt);
    } catch (err) {
      if (!this._loggedError) { console.error('frame error', err); this._loggedError = true; }
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.globalAlpha = 1;
      this.ctx.globalCompositeOperation = 'source-over';
    }
    inputEndFrame();
    // how long this frame's work actually took, vsync excluded: the only
    // honest measure of whether there is room to turn quality back up
    this.workMs = performance.now() - workStart;
    requestAnimationFrame(this.loop);
  }

  handleGlobalKeys() {
    // a focused text field or a pending rebind owns the keyboard
    if (Input.captureText) return;
    if (Input.pressed.has('ctrl+m')) {
      this.debugOpen = !this.debugOpen;
      Sfx.ui();
    }
    // The bestiary toggles from exactly one place. Handling the same key in
    // updateCodex as well would open and close it inside a single frame.
    if (Input.pressed.has(Binds.codex) && !this.debugOpen &&
        (this.screen === 'playing' || this.screen === 'paused')) {
      this.toggleCodex();
      return;
    }
    if (!Input.pressed.has('Escape')) return;
    if (this.debugOpen) { this.debugOpen = false; return; }
    if (this.codex) { this.closeCodex(); return; }
    if (this.screen === 'playing') {
      if (this.invOpen) this.invOpen = false;
      else this.screen = 'paused';
    } else if (this.screen === 'paused') {
      this.screen = 'playing';
    } else if (this.screen === 'modeSelect') {
      this.screen = 'classSelect';
    } else if (this.screen === 'weaponSelect') {
      this.screen = 'modeSelect';
    } else if (this.screen === 'perkSlot') {
      this.perkSlot = null;
      this.screen = 'weaponSelect';
    } else if (this.screen === 'settings' || this.screen === 'controls' || this.screen === 'classSelect') {
      this.screen = this.returnScreen || 'menu';
      this.returnScreen = null;
    }
  }

  // Anything that stops the world: a menu, a popup, the god's held breath.
  get worldFrozen() {
    return this.screen !== 'playing' || this.invOpen || !!this.fold || !!this.forge || !!this.codex
      || this.debugOpen || this.timeStopT > 0;
  }

  update(dt) {
    updateWorld(dt, this.worldFrozen);
    if (this.screen === 'playing' && !this.cutscene.active) this.runTime += dt;

    if (this.cutscene.active) {
      if (this.screen !== 'playing' || !this.player || this.player.dead) this.cutscene.finish();
      else {
        this.cutscene.update(dt);
        for (const e of this.enemies) e.anim += dt;
        if (this.boss && this.boss.cinematicUpdate) this.boss.cinematicUpdate(dt);
        return;
      }
    }

    this.carryRiders();
    if (this.screen === 'gameover') this.deathT += dt;

    const p = this.player;
    if (!p) return;

    // The forge holds the whole world still until you close it.
    if (this.forge) {
      if (p.dead || this.screen !== 'playing') { this.forge = null; return; }
      this.updateForge(dt);
      return;
    }
    // The fold wheel holds the whole world still until you pick one.
    if (this.fold) {
      if (p.dead || this.screen !== 'playing') { this.fold = null; return; }
      this.updateFoldWheel(dt);
      return;
    }

    if (Input.pressed.has(Binds.inventory) && this.screen === 'playing' && !p.dead) {
      this.invOpen = !this.invOpen;
      Sfx.ui();
    }
    if (!this.invOpen) {
      if (Input.wheel !== 0) {
        p.inventory.cycle(sign(Input.wheel));
        Sfx.ui();
      }
      for (let i = 1; i <= HOTBAR_SIZE; i++) {
        if (Input.pressed.has(String(i))) { p.inventory.selected = i - 1; Sfx.ui(); }
      }
    }
    const frozen = this.timeStopT > 0;
    if (frozen) {
      this.timeStopT -= dt;
      if (this.timeStopT <= 0) this.timeStopT = 0;
    }
    p.controls = !frozen && !this.invOpen && this.screen === 'playing' && !p.dead;

    // --- right click interact
    if (Input.mouseDown.right && !this.invOpen && !frozen && this.screen === 'playing') this.interact();

    if (frozen) {
      // held in amber: pose only, no physics, no timers running down
      p.vx = 0;
      p.vy = 0;
      p.anim += dt * 0.15;
    } else {
      p.update(dt, Input);
    }

    // --- waves
    if (!this.roomCleared && !frozen) this.updateWaves(dt);

    if (this.boss) this.boss.update(dt);
    // Frozen: nothing acts. Anything still materialising keeps doing that, so
    // the shardlings the god calls up actually appear during the stop.
    for (const e of this.enemies) { if (!frozen || e.spawnT > 0) e.update(dt); }
    // contact damage from bodies
    if (!frozen) for (const e of this.enemies) {
      if (e.dead || e.spawnT > 0 || e.def.flying || e.noContact || e.untargetable) continue;
      if (Math.abs(e.cx - p.x) < (e.w + p.w) / 2 - 1 && Math.abs(e.cy - p.cy) < (e.h + p.h) / 2 - 1) {
        if (p.dashT <= 0) {
          p.hurt(Math.round(e.dmg * 0.35), e.x);
          // some bodies are poisonous to be near, not just to be hit by
          if (e.def.poisonSeconds > 0) p.applyPoison(e.def.poisonSeconds);
        }
      }
    }
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (this.enemies[i].dead) this.enemies.splice(i, 1);
    }

    // --- projectiles
    if (!frozen) for (const pr of this.projectiles) {
      pr.update(dt);
      if (pr.dead) continue;
      if (pr.spent) continue;      // out of range: falling, and harmless
      if (pr.team === 'player') {
        for (const e of this.enemies) {
          if (e.dead || e.spawnT > 0 || e.untargetable) continue;
          if (pr.canHit && !pr.canHit(e)) continue;
          if (Math.abs(pr.x - e.cx) < e.w / 2 + 2 && Math.abs(pr.y - e.cy) < e.h / 2 + 2) {
            pr.onHit(e, this);
            break;
          }
        }
      } else if (!p.dead && p.dashT <= 0 && p.invuln <= 0) {
        if (Math.abs(pr.x - p.x) < p.w / 2 + 2 && Math.abs(pr.y - p.cy) < p.h / 2 + 2) pr.onHit(p, this);
      }
    }
    if (!frozen) this.updateShardCollisions();
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      if (this.projectiles[i].dead) this.projectiles.splice(i, 1);
    }

    if (!frozen) this.updatePaperShields(dt);
    for (const pk of this.pickups) pk.update(dt);
    if (this.anvil) this.anvil.update(dt, this.player);
    if (this.portal) this.portal.update(dt);

    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const s = this.shockwaves[i];
      s.t += dt;
      if (s.t > 0.45) this.shockwaves.splice(i, 1);
    }
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      this.bolts[i].t += dt;
      if (this.bolts[i].t > this.bolts[i].life) this.bolts.splice(i, 1);
    }
  }

  // Anything riding a drifting platform moves with it: bodies standing on top,
  // arrows lodged in it, and a grappling hook biting into it.
  carryRiders() {
    for (const e of [this.player, ...this.enemies]) {
      if (!e || e.dead) continue;
      const p = e.platform;
      if (p && p.dx) e.x = clamp(e.x + p.dx, e.w / 2, VIEW_W - e.w / 2);
    }
    for (const pr of this.projectiles) {
      if (pr.dead || !pr.stuck || !pr.stuckTo || !pr.stuckTo.dx) continue;
      pr.x += pr.stuckTo.dx;
    }
    const g = this.player?.grapple;
    if (g && g.state === 'attached' && g.anchor && g.anchor.dx) {
      g.x += g.anchor.dx;
      // the rope has to keep up, or the swing snaps against a stale length
      g.len = Math.max(GRAPPLE.minLength, dist(this.player.x, this.player.cy, g.x, g.y));
    }
  }

  updateWaves(dt) {
    if (this.cutscene.active) return;
    this.waveTimer += dt;
    while (this.pendingSpawns.length && this.pendingSpawns[0].delay <= this.waveTimer) {
      const s = this.pendingSpawns.shift();
      this.enemies.push(new Enemy(s.type, s.x, s.y, this));
    }
    if (this.pendingSpawns.length === 0 && this.enemies.every((e) => e.dead)) {
      if (this.waveCooldown === null || this.waveCooldown === undefined) {
        // wave just ended: patch the player up before the next one lands
        this.waveCooldown = WAVES.interWaveDelay;
        this.player.healPct(WAVE_HEAL);
        if (this.player.classId === 'origamist') {
          const got = this.givePaper(ORIGAMI.wavePaper);
          if (got > 0) floatText(this.player.x, this.player.cy - 20, `+${got} PAPER`, '#efeade', { life: 1.1 });
        }
      }
      this.waveCooldown -= dt;
      if (this.waveCooldown <= 0) {
        this.waveCooldown = null;
        if (this.waveIndex < this.wavesInRoom()) this.startWave(this.waveIndex + 1);
        else this.clearRoom();
      }
    }
  }

  clearRoom() {
    this.roomCleared = true;
    // The vault has no room past the god.
    if (this.roomIndex >= this.lastRoom) { this.finishRun(); return; }
    // A rush has no room to walk around picking things up in: the spoils are
    // offered on their own screen and the next boss follows on a timer.
    if (this.mode === 'bossrush') { this.openRushReward(); return; }
    if (this.isBossRoom()) {
      // two offers on the centre platform, one pick
      const inv = this.player.inventory;
      const [rolledA, rolled] = rollPerkPair(inv, this.roomRoll('perk'));
      // The Undead Ceiling only ever hands over the Damage Booster.
      if (this.boss && this.boss.def.id === 'ceiling' && !inv.has('damagebooster')) {
        this.dropBossPair('damagebooster', null);
        this.finishClearRoom();
        return;
      }
      // Big Dude keeps the Paper Missile tutor in the first slot, once
      const wantsBook = this.boss && this.boss.def.id === 'bigdude' &&
        !inv.has('bookmissile');
      const a = wantsBook ? 'bookmissile' : rolledA;
      // The second offer is normally the Nukerang, once. An Origamist has no
      // use for it, so they are taught the Paper Missile instead.
      let b;
      if (this.player.classId === 'origamist') {
        b = inv.has('bookmissile') ? rolled : 'bookmissile';
      } else {
        b = inv.has('nukerang') ? rolled : 'nukerang';
      }
      this.dropBossPair(a, b);
    } else {
      const id = rollDrop(this.player.inventory, this.roomRoll('perk'));
      this.pickups.push(new Pickup(id, DROP_POINT.x, DROP_POINT.y));
      burst(DROP_POINT.x, DROP_POINT.y - 12, 26, {
        color: RARITY[ITEMS[id].rarity].color, color2: '#ffffff',
        speedMin: 30, speedMax: 140, lifeMin: 0.3, lifeMax: 0.8, gravity: 120,
      });
    }
    this.finishClearRoom();
  }

  // Lay a boss's offers on the centre platform. Pass a single id to hand over
  // one thing that is not a choice at all.
  dropBossPair(a, b) {
    const group = b ? `boss-${this.roomIndex}` : null;
    if (b) {
      this.pickups.push(new Pickup(a, DROP_POINT.x - 26, DROP_POINT.y, group));
      this.pickups.push(new Pickup(b, DROP_POINT.x + 26, DROP_POINT.y, group));
    } else {
      this.pickups.push(new Pickup(a, DROP_POINT.x, DROP_POINT.y));
    }
    for (const pk of this.pickups) {
      burst(pk.x, pk.y - 12, 24, {
        color: RARITY[ITEMS[pk.itemId].rarity].color, color2: '#ffffff',
        speedMin: 30, speedMax: 140, lifeMin: 0.3, lifeMax: 0.8, gravity: 120,
      });
    }
  }

  finishClearRoom() {
    this.portal = new Portal(VIEW_W - 34, GROUND_Y);
    Camera.add(4);
    Sfx.pickup();
  }

  interact() {
    const p = this.player;
    const mx = Input.mouse.x, my = Input.mouse.y;
    // pickups first
    for (let i = 0; i < this.pickups.length; i++) {
      const pk = this.pickups[i];
      if (pk.disabled) continue;
      if (dist(mx, my, pk.x, pk.y - 12) > 22) continue;
      if (dist(p.x, p.cy, pk.x, pk.y - 12) > 64) return;
      if (!p.inventory.canAccept(pk.itemId)) { Sfx.ui(); return; }
      p.inventory.add(pk.itemId, 1);
      p.recomputeStats();
      const def = ITEMS[pk.itemId];
      burst(pk.x, pk.y - 12, 26, { color: RARITY[def.rarity].color, color2: '#ffffff', speedMin: 20, speedMax: 130, lifeMin: 0.2, lifeMax: 0.7 });
      Sfx.pickup();
      this.pickups.splice(i, 1);
      // taking one of a choice pair burns the other
      if (pk.group) {
        for (const other of this.pickups) {
          if (other.group === pk.group) other.disabled = true;
        }
      }
      return;
    }
    // the anvil
    if (this.anvil && dist(mx, my, this.anvil.x, this.anvil.y - 8) < 24 &&
        dist(p.x, p.cy, this.anvil.x, this.anvil.y - 8) < ANVIL.reach) {
      this.openForge();
      return;
    }
    // portal
    if (this.portal && this.roomCleared) {
      if (dist(mx, my, this.portal.x, this.portal.y - 18) < 26) {
        Camera.punch(-1.6);
        if (dist(p.x, p.cy, this.portal.x, this.portal.y - 18) > 70) return;
        burst(this.portal.x, this.portal.y - 18, 30, { color: Theme.platformGlow, speedMin: 30, speedMax: 160, lifeMin: 0.3, lifeMax: 0.7 });
        Camera.add(6);
        this.startRoom(this.roomIndex + 1);
        return;
      }
    }
  }

  // --- render ------------------------------------------------------------

  render(dt) {
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = Theme.bgFar;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    if (this.screen === 'menu') { drawMainMenu(ctx, this, this.time); if (this.debugOpen) drawDebugMenu(ctx, this); this.drawToast(ctx); return; }
    if (this.screen === 'settings') { drawSettings(ctx, this, this.time); if (this.debugOpen) drawDebugMenu(ctx, this); this.drawToast(ctx); return; }
    if (this.screen === 'controls') { drawControls(ctx, this, this.time); if (this.debugOpen) drawDebugMenu(ctx, this); this.drawToast(ctx); return; }
    if (this.screen === 'classSelect') { drawClassSelect(ctx, this, this.time); if (this.debugOpen) drawDebugMenu(ctx, this); this.drawToast(ctx); return; }
    if (this.screen === 'modeSelect') { drawModeSelect(ctx, this, this.time); if (this.debugOpen) drawDebugMenu(ctx, this); this.drawToast(ctx); return; }
    if (this.screen === 'weaponSelect') { drawWeaponSelect(ctx, this, this.time); if (this.debugOpen) drawDebugMenu(ctx, this); this.drawToast(ctx); return; }
    if (this.screen === 'perkSlot') { drawPerkSlot(ctx, this, this.time); if (this.debugOpen) drawDebugMenu(ctx, this); this.drawToast(ctx); return; }

    ctx.save();
    Camera.apply(ctx);
    drawBackground(ctx, this.time, this.roomIndex);
    drawLightShafts(ctx, this.time);
    drawArena(ctx, this.time);
    if (!this.roomCleared) drawSpawnPads(ctx, this.time, activeSpawnPads(this.waveIndex));

    // slam shockwaves
    for (const s of this.shockwaves) {
      const k = s.t / 0.45;
      const r = s.r * (0.3 + k * 1.5);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba(Theme.uiAccent, (1 - k) * 0.8);
      ctx.lineWidth = 3 * (1 - k) + 1;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y - 2, r, r * 0.35, 0, Math.PI, 0);
      ctx.stroke();
      ctx.restore();
    }

    for (const pk of this.pickups) pk.draw(ctx);
    if (this.anvil) this.anvil.draw(ctx);
    if (this.portal) this.portal.draw(ctx);
    for (const e of this.enemies) e.draw(ctx);
    if (this.boss && this.boss.draw) this.boss.draw(ctx);
    for (const pr of this.projectiles) pr.draw(ctx);
    if (this.player) this.player.draw(ctx);
    this.drawPaperShields(ctx);

    if (this.boss && this.boss.drawBeams) this.boss.drawBeams(ctx);

    for (const b of this.bolts) {
      const k = 1 - b.t / b.life;
      strokeBolt(ctx, b.pts, '#ffffff', 3 * k + 1, k * 0.9);
      strokeBolt(ctx, b.pts, Theme.lightning, 6 * k + 1, k * 0.45);
    }

    drawParticles(ctx);
    drawRings(ctx);
    drawTexts(ctx);
    // aim reticle lives inside the camera so it tracks the cursor exactly
    if (this.screen === 'playing' && !this.invOpen && this.player && !this.player.dead) {
      if (Options.showHitbox) this.drawHitboxes(ctx);
      if (Options.showRange) this.drawRangeRing(ctx);
      if (Options.showCooldown) this.drawCooldownRing(ctx);
      drawAimLeash(ctx, this);
      if (Options.showReticle || Pad.active) this.drawReticle(ctx);
    }
    ctx.restore();

    drawFlash(ctx, VIEW_W, VIEW_H);
    if (!this.cutscene.active && this.screen !== 'victory') drawHUD(ctx, this);
    drawTouchPad(ctx, this);
    this.cutscene.draw(ctx);
    if (this.fold) drawFoldWheel(ctx, this);
    if (this.forge) drawForge(ctx, this);
    if (this.invOpen) drawInventory(ctx, this);
    else if (UI.tooltip) drawTooltip(ctx, UI.tooltip);

    if (this.screen === 'paused') drawPause(ctx, this, this.time);
    if (this.screen === 'gameover') drawGameOver(ctx, this, this.time);
    if (this.screen === 'victory') drawVictory(ctx, this, this.time);
    if (this.screen === 'rushReward') drawRushReward(ctx, this, this.time);
    // over the pause menu, since that is where a phone reaches it from
    if (this.codex) drawCodex(ctx, this);
    if (this.debugOpen) drawDebugMenu(ctx, this);
    this.drawToast(ctx);
  }

  // --- hitboxes -----------------------------------------------------------
  // What the game actually measures, drawn exactly where it measures it. Not
  // an approximation of the sprite: these read the same numbers the collision
  // code does, so if a hit looks wrong this is what to believe.
  //
  //   blue      you
  //   red       an enemy
  //   yellow    something of yours that can hurt them
  //   dark red  something of theirs that can hurt you

  drawHitboxes(ctx) {
    const p = this.player;
    ctx.save();
    ctx.lineWidth = 1;

    // Dark red on a dark game is very nearly invisible, so anything drawn in
    // it gets a thin bright edge outside the line. The colour still says which
    // is which; the halo is only so the shape can be found at all.
    const box = (cx, cy, w, h, color, fill) => {
      const x = Math.round(cx - w / 2) + 0.5, y = Math.round(cy - h / 2) + 0.5;
      const bw = Math.round(w), bh = Math.round(h);
      if (fill) { ctx.fillStyle = rgba(color, 0.2); ctx.fillRect(x, y, bw, bh); }
      if (color === HITBOX.enemyAttack) {
        ctx.strokeStyle = rgba('#ffffff', 0.28);
        ctx.strokeRect(x - 1, y - 1, bw + 2, bh + 2);
      }
      ctx.strokeStyle = rgba(color, 0.95);
      ctx.strokeRect(x, y, bw, bh);
    };
    const dot = (cx, cy, r, color) => {
      ctx.strokeStyle = color.length > 7 ? color : rgba(color, 0.9);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1.5, r), 0, TAU);
      ctx.stroke();
    };

    // --- you
    if (p && !p.dead) box(p.x, p.cy, p.w, p.h, HITBOX.player, true);

    // --- them. An enemy that cannot be hit is drawn hollow and dashed, so
    // "my shots pass through it" has an answer on screen.
    for (const e of this.enemies) {
      if (e.dead) continue;
      const untouchable = e.spawnT > 0 || e.untargetable;
      ctx.setLineDash(untouchable ? [2, 3] : []);
      box(e.cx, e.cy, e.w, e.h, HITBOX.enemy, !untouchable);
      ctx.setLineDash([]);
    }

    // --- what each side has in the air
    for (const pr of this.projectiles) {
      if (pr.dead) continue;
      const mine = pr.team === 'player';
      const c = mine ? HITBOX.playerAttack : HITBOX.enemyAttack;
      // a spent projectile has stopped being an attack
      if (!mine) dot(pr.x, pr.y, 6, '#ffffff33');
      dot(pr.x, pr.y, pr.spent ? 3 : 5, c);
      if (!pr.spent) box(pr.x, pr.y, 8, 8, c, true);
    }

    // --- your swing, drawn as the arc the hit test actually sweeps
    if (p && p.swing && (p.swing.kind === 'melee' || p.swing.kind === 'thrust')) {
      const sw = p.swing;
      const live = sw.t < (sw.kind === 'thrust' ? STIDENT.thrustTime : SWORD.swingTime);
      if (live && sw.range) {
        ctx.strokeStyle = rgba(HITBOX.playerAttack, 0.95);
        ctx.fillStyle = rgba(HITBOX.playerAttack, 0.22);
        ctx.beginPath();
        ctx.moveTo(p.x, p.cy);
        ctx.arc(p.x, p.cy, sw.range, sw.angle - sw.arc, sw.angle + sw.arc);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

    // --- their melee, for the frames it is actually live
    for (const e of this.enemies) {
      if (e.dead || !e.slash) continue;
      const reach = (e.def.attackRange ?? 16) + 6;
      const x = Math.round(e.x + (e.facing > 0 ? 0 : -reach)) + 0.5;
      const y = Math.round(e.cy - 24) + 0.5;
      ctx.fillStyle = rgba(HITBOX.enemyAttack, 0.22);
      ctx.fillRect(x, y, reach, 48);
      ctx.strokeStyle = rgba('#ffffff', 0.28);
      ctx.strokeRect(x - 1, y - 1, reach + 2, 50);
      ctx.strokeStyle = rgba(HITBOX.enemyAttack, 0.95);
      ctx.strokeRect(x, y, reach, 48);
    }

    // --- and the beams, which are attacks with no body at all
    if (this.boss && this.boss.ray && this.boss.ray.ox !== undefined) {
      const b = this.boss.ray;
      ctx.strokeStyle = rgba(HITBOX.enemyAttack, 0.85);
      ctx.beginPath();
      ctx.moveTo(b.ox, b.oy ?? 0);
      ctx.lineTo(b.ox, GROUND_Y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // A faint ring at the reach of whatever you are holding, for players who
  // want to see exactly where a swing or a shot stops.
  drawRangeRing(ctx) {
    const p = this.player;
    const w = p.inventory.selectedWeapon();
    let r = SWORD.range * 0.5;
    if (w) {
      if (w.id === 'twindagger') r = TWINDAGGER.range;
      else if (w.weapon === 'trident') r = STIDENT.range + (p.armorBuff?.meleeRange ?? 0) * BLOCK;
      else if (w.weapon === 'melee') r = SWORD.range;
      else if (w.weapon === 'stingergun') r = STINGER_GUN.range;
      else if (w.weapon === 'bow') r = BOW.range;
      else if (w.weapon === 'shardgun') r = SHARDGUN.range;
      else if (w.weapon === 'boomerang') r = NUKERANG.range;
      else if (w.weapon === 'paper') r = 0;
    }
    if (r <= 0) return;
    ctx.save();
    ctx.strokeStyle = rgba(Theme.uiDim, 0.30);
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.lineDashOffset = -this.time * 12;
    ctx.beginPath();
    ctx.arc(p.x, p.cy, r, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    // A swing snaps to one of eight directions, so the ring says which one it
    // is about to take - otherwise the cursor and the strike disagree.
    const melee = !w || w.weapon === 'melee' || w.weapon === 'trident';
    if (melee) {
      const a = snapAngle(p.aim, 8);
      const arc = (w && w.id === 'twindagger' ? TWINDAGGER.arc
        : w && w.weapon === 'trident' ? STIDENT.arc : SWORD.arc) * 0.95;
      ctx.strokeStyle = rgba(Theme.uiAccent, 0.5);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.cy, r, a - arc, a + arc);
      ctx.stroke();
      const tx = p.x + Math.cos(a) * r, ty = p.cy + Math.sin(a) * r;
      pxRect(ctx, tx - 1, ty - 1, 2, 2, rgba('#ffffff', 0.7));
    }
    ctx.restore();
  }

  // A short arc over the player's head that fills back up as the weapon comes
  // off cooldown. Reads at a glance without adding a number to the HUD.
  drawCooldownRing(ctx) {
    const p = this.player;
    const w = p.inventory.selectedWeapon();
    const full = w
      ? (w.id === 'twindagger' ? TWINDAGGER.cooldown
        : w.weapon === 'bow' ? BOW.cooldown
          : w.weapon === 'shardgun' ? SHARDGUN.cooldown
            : w.weapon === 'stingergun' ? STINGER_GUN.cooldown
              : w.weapon === 'trident' ? STIDENT.cooldown
                : w.weapon === 'paper' ? ORIGAMI.forms.missile.cooldown
              : w.weapon === 'boomerang' ? NUKERANG.cooldown : SWORD.cooldown)
      : 0.35;
    const busy = p.reloadT > 0 ? p.reloadT / ((this.player.gunCfg()?.reload) || 1)
      : clamp(p.attackCd / full, 0, 1);
    if (busy <= 0.01) return;
    const k = 1 - busy;
    const cx = p.x, cy = p.y - p.h - 9;
    const r = 7;
    ctx.save();
    ctx.lineCap = 'butt';
    ctx.strokeStyle = rgba('#000000', 0.5);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI * 0.85, Math.PI * 0.15, false);
    ctx.stroke();
    ctx.strokeStyle = p.reloadT > 0 ? Theme.uiAccent : rgba(Theme.ui, 0.9);
    ctx.lineWidth = 1.6;
    const a0 = Math.PI * 0.85;
    const span = Math.PI * 1.3;
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a0 + span * k, false);
    ctx.stroke();
    ctx.restore();
  }

  drawReticle(ctx) {
    const m = Input.mouse;
    const t = this.time * 4;
    const r = 5 + Math.sin(t) * 0.8;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = rgba(Theme.uiAccent, 0.85);
    ctx.lineWidth = 1;
    for (let i = 0; i < 4; i++) {
      const a = t * 0.3 + i * Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(m.x + Math.cos(a) * r, m.y + Math.sin(a) * r);
      ctx.lineTo(m.x + Math.cos(a) * (r + 3), m.y + Math.sin(a) * (r + 3));
      ctx.stroke();
    }
    pxRect(ctx, m.x, m.y, 1, 1, Theme.uiAccent);
    ctx.restore();
  }

  drawToast(ctx) {
    if (this.hintT <= 0 || !this.hint) return;
    const a = clamp(this.hintT, 0, 1);
    ctx.globalAlpha = a;
    drawTextShadow(ctx, this.hint, VIEW_W / 2, VIEW_H - 42, Theme.uiAccent, 1, 'center');
    ctx.globalAlpha = 1;
  }
}

export const SAMPLE_SHDR = `/*@theme
{
  "name": "Neon Veil",
  "bgFar": "#12001f", "bgMid": "#1c0033", "bgNear": "#2a0047",
  "fog": "#3d0a63", "ground": "#2b0246", "groundTop": "#ff2bd6",
  "groundEdge": "#00ffe1", "platform": "#33055a", "platformTop": "#ff2bd6",
  "platformGlow": "#00ffe1", "player": "#ffffff", "cloth": "#ff2bd6",
  "clothDark": "#8a0f6d", "skin": "#ffd9f2", "steel": "#00ffe1",
  "enemyGrunt": "#ffe600", "enemyBrute": "#ff5c00", "enemyStinger": "#00ff85",
  "uiAccent": "#00ffe1", "ui": "#ffe6fb", "uiPanel": "#1a0030",
  "bloomStrength": 1.7, "bloomThreshold": 0.42, "scanline": 0.35,
  "chroma": 1.2, "saturation": 1.35, "vignette": 0.7, "animSpeed": 1.15
}
@*/
precision mediump float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2  uResolution;
uniform float uTime;
uniform float uBloomStrength;
uniform float uVignette;
uniform float uChroma;
uniform float uScanline;
uniform float uSaturation;
uniform float uHit;

void main() {
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);

  // wavy neon distortion
  uv.x += sin(uv.y * 40.0 + uTime * 2.0) * 0.0015;

  vec2 off = c * r2 * 0.02 * uChroma;
  vec3 col;
  col.r = texture2D(uScene, uv + off).r;
  col.g = texture2D(uScene, uv).g;
  col.b = texture2D(uScene, uv - off).b;

  vec3 bloom = texture2D(uBloom, uv).rgb;
  col += bloom * uBloomStrength * vec3(1.1, 0.85, 1.3);

  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l), col, uSaturation);
  col *= mix(vec3(1.0), vec3(1.15, 0.8, 1.25), 0.5);
  col += vec3(0.6, 0.0, 0.15) * uHit;

  float scan = 1.0 - uScanline * 0.6 * (0.5 + 0.5 * sin(uv.y * uResolution.y * 3.14159));
  col *= scan;
  col *= 1.0 - uVignette * r2 * 1.2;
  gl_FragColor = vec4(col, 1.0);
}
`;
