// Game shell: canvas setup, main loop, run/room/wave state machine.
import { clamp, lerp, rand, randInt, dist, distToSegment, rgba, sign } from './util.js';
import { Theme, applyTheme, resetTheme, DEFAULT_THEME } from './theme.js';
import {
  Camera, updateFx, drawParticles, drawTexts, drawRings, clearFx, burst, floatText,
  spawnParticle, impactRing, boltPath, strokeBolt, glowDot, pxRect,
} from './gfx.js';
import { Input, initInput, inputTick, inputEndFrame } from './input.js';
import { Sfx, resumeAudio, setVolume, AudioCfg } from './audio.js';
import { PostFX, parseShaderPack, DEFAULT_COMPOSITE } from './postfx.js';
import {
  VIEW_W, VIEW_H, GROUND_Y, PLATFORMS, DROP_POINT, PERK, WAVES, PLAYER as PCFG,
  BOSS_ROOM_INTERVAL, NUKERANG,
} from './config.js';
import { Player, Enemy, Projectile } from './entities.js';
import { makeBoss } from './boss.js';
import { Cutscene } from './cutscene.js';
import { drawBackground, drawArena, drawSpawnPads, updateWorld, buildWave, activeSpawnPads, Pickup, Portal } from './world.js';
import { ITEMS, RARITY, HOTBAR_SIZE, rollDrop, rollPerkPair, drawItemIcon } from './items.js';
import { UI, uiBeginFrame, drawHUD, drawInventory, drawTooltip, drawDebugMenu, panel, button } from './ui.js';
import { drawText, drawTextShadow } from './font.js';
import { drawMainMenu, drawSettings, drawClassSelect, drawPause, drawGameOver, drawControls } from './screens.js';

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
    this.bolts = [];
    this.pendingSpawns = [];
    this.portal = null;
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
    this.hint = null;
    this.hintT = 0;

    this.resize();
    addEventListener('resize', () => this.resize());
    initInput({ canvas: this.display, toWorld: (sx, sy) => this.toWorld(sx, sy) });
    this.setupShaderInput(root);

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

  applyShaderPack(text, fallbackName) {
    try {
      const pack = parseShaderPack(text);
      applyTheme(pack.theme);
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
      this.toast(`SHADER LOADED: ${this.shaderName}`);
    } catch (err) {
      this.shaderError = String(err.message || err).slice(0, 60);
    }
  }

  resetShader() {
    resetTheme();
    this.postfx.resetComposite();
    this.shaderName = null;
    this.shaderError = null;
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
    clearFx();
    this.player = new Player(this, classId);
    this.enemies.length = 0;
    this.projectiles.length = 0;
    this.pickups.length = 0;
    this.shockwaves.length = 0;
    this.bolts.length = 0;
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
    this.player.x = 120;
    this.player.y = GROUND_Y;
    this.player.vx = this.player.vy = 0;
    this.player.boomerangOut = null;
    this.player.resetChains();
    if (index > 1) this.player.healPct(1);
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

  onEnemyKilled() {
    this.kills++;
  }

  // Called by a boss the moment its pool empties.
  onBossDefeated(boss) {
    if (this.screen !== 'playing') return;
    this.cutscene.play('outro', boss);
  }

  onPlayerDeath() {
    this.screen = 'gameover';
    this.deathT = 0;
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
    const damage = big ? NUKERANG.bigDamage : NUKERANG.hitDamage;
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
    if (big) this.hitstop(0.07);
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

    let gdt = dt;
    if (this.freezeT > 0) {
      this.freezeT -= dt;
      gdt = dt * 0.08;
    }
    this.postfx.slowmo = lerp(this.postfx.slowmo, this.freezeT > 0 ? 1 : 0, 1 - Math.pow(0.001, dt));

    // One bad frame must never end the run: log it and keep the loop alive.
    try {
      this.handleGlobalKeys();
      if (this.debugOpen) {
        updateWorld(dt);
      } else if (this.screen === 'playing' || this.screen === 'gameover') {
        this.update(gdt);
      } else {
        updateWorld(dt);
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

  update(dt) {
    updateWorld(dt);

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

    if (Input.pressed.has('e') && this.screen === 'playing' && !p.dead) {
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
    p.controls = !this.invOpen && this.screen === 'playing' && !p.dead;

    // --- right click interact
    if (Input.mouseDown.right && !this.invOpen && this.screen === 'playing') this.interact();

    p.update(dt, Input);

    // --- waves
    if (!this.roomCleared) this.updateWaves(dt);

    if (this.boss) this.boss.update(dt);
    for (const e of this.enemies) e.update(dt);
    // contact damage from bodies
    for (const e of this.enemies) {
      if (e.dead || e.spawnT > 0 || e.def.flying || e.noContact || e.untargetable) continue;
      if (Math.abs(e.cx - p.x) < (e.w + p.w) / 2 - 1 && Math.abs(e.cy - p.cy) < (e.h + p.h) / 2 - 1) {
        if (p.dashT <= 0) p.hurt(Math.round(e.dmg * 0.35), e.x);
      }
    }
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (this.enemies[i].dead) this.enemies.splice(i, 1);
    }

    // --- projectiles
    for (const pr of this.projectiles) {
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
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      if (this.projectiles[i].dead) this.projectiles.splice(i, 1);
    }

    for (const pk of this.pickups) pk.update(dt);
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

  // Anything standing on a drifting platform moves with it.
  carryRiders() {
    for (const e of [this.player, ...this.enemies]) {
      if (!e || e.dead) continue;
      const p = e.platform;
      if (p && p.dx) e.x = clamp(e.x + p.dx, e.w / 2, VIEW_W - e.w / 2);
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
    if (this.isBossRoom()) {
      // two offers on the centre platform, one pick
      const [a, rolled] = rollPerkPair();
      // the second offer is always the Nukerang the first time it comes up
      const b = this.player.inventory.has('nukerang') ? rolled : 'nukerang';
      const group = `boss-${this.roomIndex}`;
      this.pickups.push(new Pickup(a, DROP_POINT.x - 26, DROP_POINT.y, group));
      this.pickups.push(new Pickup(b, DROP_POINT.x + 26, DROP_POINT.y, group));
      for (const pk of this.pickups) {
        burst(pk.x, pk.y - 12, 24, {
          color: RARITY[ITEMS[pk.itemId].rarity].color, color2: '#ffffff',
          speedMin: 30, speedMax: 140, lifeMin: 0.3, lifeMax: 0.8, gravity: 120,
        });
      }
    } else {
      const id = rollDrop(this.player.inventory);
      this.pickups.push(new Pickup(id, DROP_POINT.x, DROP_POINT.y));
      burst(DROP_POINT.x, DROP_POINT.y - 12, 26, {
        color: RARITY[ITEMS[id].rarity].color, color2: '#ffffff',
        speedMin: 30, speedMax: 140, lifeMin: 0.3, lifeMax: 0.8, gravity: 120,
      });
    }
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
    if (this.portal) this.portal.draw(ctx);
    for (const e of this.enemies) e.draw(ctx);
    if (this.boss && this.boss.draw) this.boss.draw(ctx);
    for (const pr of this.projectiles) pr.draw(ctx);
    if (this.player) this.player.draw(ctx);

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
      this.drawReticle(ctx);
    }
    ctx.restore();

    if (!this.cutscene.active) drawHUD(ctx, this);
    this.cutscene.draw(ctx);
    if (this.invOpen) drawInventory(ctx, this);
    else if (UI.tooltip) drawTooltip(ctx, UI.tooltip);

    if (this.screen === 'paused') drawPause(ctx, this, this.time);
    if (this.screen === 'gameover') drawGameOver(ctx, this, this.time);
    if (this.debugOpen) drawDebugMenu(ctx, this);
    this.drawToast(ctx);
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
