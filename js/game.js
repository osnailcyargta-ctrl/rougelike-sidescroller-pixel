// Game shell: canvas setup, main loop, run/room/wave state machine.
import { clamp, lerp, rand, randInt, dist, distToSegment, rgba, sign, setSeed, getSeed, randomSeedText, TAU } from './util.js';
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
  ARMOR, PAPER_SHIELD, ANVIL, GRAPPLE,
} from './config.js';
import { Player, Enemy, Projectile, SHARD_TINT, INK, doodleShape, doodleLine } from './entities.js';
import { makeBoss } from './boss.js';
import { Cutscene } from './cutscene.js';
import { drawBackground, drawArena, drawLightShafts, drawSpawnPads, updateWorld, buildWave, activeSpawnPads, Pickup, Portal, Anvil } from './world.js';
import { ITEMS, RARITY, HOTBAR_SIZE, rollDrop, rollPerkPair, drawItemIcon } from './items.js';
import { UI, uiBeginFrame, drawHUD, drawInventory, drawTooltip, drawDebugMenu, drawFoldWheel, drawForge, panel, button } from './ui.js';
import { drawText, drawTextShadow } from './font.js';
import { Options, loadOptions, saveOptions, applyVisualOptions, captureShaderBase, saveShader, loadShader } from './settings.js';
import { drawMainMenu, drawSettings, drawClassSelect, drawPause, drawGameOver, drawControls, drawVictory } from './screens.js';

// Health restored to the player after every cleared wave; clearing a room and
// stepping through the gate restores the rest.
const WAVE_HEAL = 0.25;

export class Game {
  static get WAVE_HEAL() { return WAVE_HEAL; }

  constructor(root) {
    this.display = root.querySelector('#screen');
    this.scene = document.createElement('canvas');
    this.scene.width = VIEW_W;
    this.scene.height = VIEW_H;
    this.ctx = this.scene.getContext('2d', { alpha: false });
    this.ctx.imageSmoothingEnabled = false;
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
    this.boss = null;
    this.cutscene = new Cutscene(this);
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
    applyVisualOptions();
    setVolume(Options.volume);

    this.resize();
    addEventListener('resize', () => this.resize());
    initInput({ canvas: this.display, toWorld: (sx, sy) => this.toWorld(sx, sy) });
    this.setupShaderInput(root);

    // and the shader pack the player was last using
    const saved = loadShader();
    if (saved) this.applyShaderPack(saved.text, saved.name, { silent: true, store: false });

    this.last = performance.now();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // --- plumbing ----------------------------------------------------------

  resize() {
    const pad = 0;
    const scale = Math.max(1, Math.min(
      Math.floor((innerWidth - pad) / VIEW_W * 2) / 2,
      Math.floor((innerHeight - pad) / VIEW_H * 2) / 2,
    ));
    this.scale = scale;
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.display.style.width = `${VIEW_W * scale}px`;
    this.display.style.height = `${VIEW_H * scale}px`;
    this.display.width = Math.round(VIEW_W * scale * dpr);
    this.display.height = Math.round(VIEW_H * scale * dpr);
  }

  toWorld(sx, sy) {
    const r = this.display.getBoundingClientRect();
    const vx = (sx / r.width) * VIEW_W;
    const vy = (sy / r.height) * VIEW_H;
    // undo the camera so aiming stays exact through shake and zoom punches
    const w = Camera.unproject(vx, vy);
    return { x: clamp(w.x, -40, VIEW_W + 40), y: clamp(w.y, -40, VIEW_H + 40) };
  }

  setupShaderInput(root) {
    this.fileInput = root.querySelector('#shaderFile');
    this.fileInput.addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const text = await f.text();
      this.applyShaderPack(text, f.name.replace(/\.shdr$/i, ''));
      this.fileInput.value = '';
    });
    // drag & drop a .shdr anywhere
    addEventListener('dragover', (e) => e.preventDefault());
    addEventListener('drop', async (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (!f || !/\.shdr$/i.test(f.name)) return;
      this.applyShaderPack(await f.text(), f.name.replace(/\.shdr$/i, ''));
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

  resetShader() {
    resetTheme();
    captureShaderBase();
    applyVisualOptions();
    this.postfx.resetComposite();
    this.shaderName = null;
    this.shaderError = null;
    saveShader(null, null);
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

  hitstop(t) { this.freezeT = Math.max(this.freezeT, t); }

  // --- run flow ----------------------------------------------------------

  goClassSelect() { resumeAudio(); this.screen = 'classSelect'; }

  startRun(classId) {
    resumeAudio();
    // an empty field means "surprise me", but the roll is still recorded so the
    // death screen can hand the seed back for a rematch
    this.activeSeed = setSeed(this.seedText.trim() || randomSeedText());
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
    this.startRoom(1);
  }

  quitToMenu() { this.screen = 'menu'; this.player = null; clearFx(); }

  isBossRoom(index = this.roomIndex) { return index % BOSS_ROOM_INTERVAL === 0; }

  wavesInRoom(index = this.roomIndex) {
    return this.isBossRoom(index) ? WAVES.bossRoomWaves : WAVES.perRoom;
  }

  startRoom(index) {
    this.roomIndex = index;
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
    if (this.isBossRoom() && n === WAVES.bossRoomWaves) {
      this.pendingSpawns = [];
      this.player.healPct(1);      // full HP going into the boss
      this.boss = makeBoss(this, this.roomIndex);
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
    this.cutscene.play('outro', boss);
  }

  onPlayerDeath() {
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
    this.runStats.room = FINAL_ROOM;
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
    return list;
  }

  openForge() {
    if (!this.player || this.forge) return;
    this.forge = { sel: 0, t: 0, list: this.forgeRecipes() };
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
    f.sel = clamp(f.sel, 0, n - 1);
    if (Input.wheel !== 0) {
      f.sel = (f.sel + sign(Input.wheel) + n) % n;
      Sfx.ui();
    }
    if (Input.pressed.has(Binds.jump) || Input.pressed.has('ArrowUp')) { f.sel = (f.sel - 1 + n) % n; Sfx.ui(); }
    if (Input.pressed.has(Binds.down) || Input.pressed.has('ArrowDown')) { f.sel = (f.sel + 1) % n; Sfx.ui(); }
    if (Input.pressed.has('Escape') || Input.mouseDown.right) { this.closeForge(); return; }
    if (f.hover >= 0 && f.hover !== undefined) f.sel = f.hover;
    if (f.t > 0.12 && Input.mouseDown.left) this.craft(f.list[f.sel]);
  }

  craft(entry) {
    const p = this.player;
    const inv = p.inventory;
    if (!entry) return;
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
    this.fold = { options, sel: 0, t: 0, aim: p.aim, rot: 0, targetRot: 0, spin: 0 };
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
    if (f.t > 0.12 && Input.mouseDown.left) this.chooseFold(f.options[f.sel].id);
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
    const id = enemy.def.dropId;
    if (!id || !ITEMS[id]) return;
    if (this.player && this.player.inventory.has(id)) return;   // one is enough
    if (Math.random() >= (enemy.def.dropChance ?? 0.1)) return;
    const pk = new Pickup(id, enemy.cx, enemy.cy, null, {
      falling: true, vx: rand(-40, 40), vy: rand(-150, -70),
    });
    this.pickups.push(pk);
    const col = RARITY[ITEMS[id].rarity].color;
    burst(enemy.cx, enemy.cy, 22, {
      color: col, color2: '#ffffff', speedMin: 40, speedMax: 190,
      lifeMin: 0.25, lifeMax: 0.7, sizeMax: 3, gravity: 180, drag: 0.9,
    });
    impactRing(enemy.cx, enemy.cy, { color: col, r0: 2, r1: 46, life: 0.45, width: 2 });
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
    let dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    inputTick(dt);
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
      this.handleGlobalKeys();
      if (this.debugOpen) {
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
      this.postfx.render(dt);
    } catch (err) {
      if (!this._loggedError) { console.error('frame error', err); this._loggedError = true; }
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.globalAlpha = 1;
      this.ctx.globalCompositeOperation = 'source-over';
    }
    inputEndFrame();
    requestAnimationFrame(this.loop);
  }

  handleGlobalKeys() {
    // a focused text field or a pending rebind owns the keyboard
    if (Input.captureText) return;
    if (Input.pressed.has('ctrl+m')) {
      this.debugOpen = !this.debugOpen;
      Sfx.ui();
    }
    if (!Input.pressed.has('Escape')) return;
    if (this.debugOpen) { this.debugOpen = false; return; }
    if (this.screen === 'playing') {
      if (this.invOpen) this.invOpen = false;
      else this.screen = 'paused';
    } else if (this.screen === 'paused') {
      this.screen = 'playing';
    } else if (this.screen === 'settings' || this.screen === 'controls' || this.screen === 'classSelect') {
      this.screen = this.returnScreen || 'menu';
      this.returnScreen = null;
    }
  }

  // Anything that stops the world: a menu, a popup, the god's held breath.
  get worldFrozen() {
    return this.screen !== 'playing' || this.invOpen || !!this.fold || !!this.forge
      || this.debugOpen || this.timeStopT > 0;
  }

  update(dt) {
    updateWorld(dt, this.worldFrozen);
    if (this.screen === 'playing' && !this.cutscene.active) this.runTime += dt;

    if (this.cutscene.active) {
      if (this.screen !== 'playing' || !this.player || this.player.dead) this.cutscene.finish();
      else {
        if (Input.pressed.size > 0 || Input.mouseDown.left || Input.mouseDown.right) this.cutscene.skip();
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
        if (p.dashT <= 0) p.hurt(Math.round(e.dmg * 0.35), e.x);
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
    if (this.roomIndex >= FINAL_ROOM) { this.finishRun(); return; }
    if (this.isBossRoom()) {
      // two offers on the centre platform, one pick
      const inv = this.player.inventory;
      const [rolledA, rolled] = rollPerkPair(inv);
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
      const id = rollDrop(this.player.inventory);
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
      if (Options.showRange) this.drawRangeRing(ctx);
      if (Options.showCooldown) this.drawCooldownRing(ctx);
      if (Options.showReticle) this.drawReticle(ctx);
    }
    ctx.restore();

    drawFlash(ctx, VIEW_W, VIEW_H);
    if (!this.cutscene.active && this.screen !== 'victory') drawHUD(ctx, this);
    this.cutscene.draw(ctx);
    if (this.fold) drawFoldWheel(ctx, this);
    if (this.forge) drawForge(ctx, this);
    if (this.invOpen) drawInventory(ctx, this);
    else if (UI.tooltip) drawTooltip(ctx, UI.tooltip);

    if (this.screen === 'paused') drawPause(ctx, this, this.time);
    if (this.screen === 'gameover') drawGameOver(ctx, this, this.time);
    if (this.screen === 'victory') drawVictory(ctx, this, this.time);
    if (this.debugOpen) drawDebugMenu(ctx, this);
    this.drawToast(ctx);
  }

  // A faint ring at the reach of whatever you are holding, for players who
  // want to see exactly where a swing or a shot stops.
  drawRangeRing(ctx) {
    const p = this.player;
    const w = p.inventory.selectedWeapon();
    let r = SWORD.range * 0.5;
    if (w) {
      if (w.id === 'twindagger') r = TWINDAGGER.range;
      else if (w.weapon === 'melee') r = SWORD.range;
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
