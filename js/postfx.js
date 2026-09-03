// WebGL post-processing: bright pass -> separable blur -> composite.
// The composite stage is what a user-supplied .shdr replaces, so a shader
// pack can repaint the entire game.
import { Theme } from './theme.js';

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG_BRIGHT = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform float uThreshold;
void main() {
  vec3 c = texture2D(uScene, vUv).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  float k = smoothstep(uThreshold, uThreshold + 0.32, l);
  gl_FragColor = vec4(c * k, 1.0);
}`;

const FRAG_BLUR = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform vec2 uDir;
void main() {
  vec4 sum = texture2D(uScene, vUv) * 0.2270270270;
  sum += texture2D(uScene, vUv + uDir * 1.3846153846) * 0.3162162162;
  sum += texture2D(uScene, vUv - uDir * 1.3846153846) * 0.3162162162;
  sum += texture2D(uScene, vUv + uDir * 3.2307692308) * 0.0702702703;
  sum += texture2D(uScene, vUv - uDir * 3.2307692308) * 0.0702702703;
  gl_FragColor = sum;
}`;

export const DEFAULT_COMPOSITE = `
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
uniform float uHit;      // 0..1 damage flash
uniform float uSlowmo;   // 0..1 slow-motion amount
uniform float uTimeStop; // 0..1 frozen time: drains the colour out of the world
uniform float uGrain;    // film grain amount
uniform float uHalation; // how far bright light bleeds

void main() {
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);

  // subtle barrel + chromatic split, scaled by pixel size so it stays crisp
  vec2 off = c * r2 * (0.010 * uChroma + uHit * 0.02);
  vec3 col;
  col.r = texture2D(uScene, uv + off).r;
  col.g = texture2D(uScene, uv).g;
  col.b = texture2D(uScene, uv - off).b;

  vec3 bloom = texture2D(uBloom, uv).rgb;
  col += bloom * uBloomStrength;

  // halation: the bloom smeared a little wider and tinted warm, the way light
  // bleeds through film. Cheap, and it is most of what makes bright pixels feel
  // like they are actually emitting.
  vec2 hp = 1.6 / uResolution;
  vec3 halo = texture2D(uBloom, uv + vec2( hp.x,  hp.y)).rgb
            + texture2D(uBloom, uv + vec2(-hp.x,  hp.y)).rgb
            + texture2D(uBloom, uv + vec2( hp.x, -hp.y)).rgb
            + texture2D(uBloom, uv + vec2(-hp.x, -hp.y)).rgb;
  // only the bright end halates, so darks stay dark instead of lifting
  float haloLum = dot(halo * 0.25, vec3(0.299, 0.587, 0.114));
  col += halo * 0.13 * uBloomStrength * uHalation * smoothstep(0.10, 0.55, haloLum)
       * vec3(1.15, 0.86, 0.62);

  // saturation
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l), col, uSaturation);

  // split tone: shadows drift cool, highlights drift warm. One line, and the
  // whole frame stops looking flat.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col *= mix(vec3(0.94, 0.98, 1.10), vec3(1.07, 1.01, 0.93), smoothstep(0.15, 0.85, lum));

  // a gentle S-curve for contrast without crushing either end
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.16);

  // slow motion pulls the colour out rather than tinting the frame blue
  float sl = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, mix(col, vec3(sl), 0.55) * 1.06, uSlowmo * 0.6);

  // stopped time: the world goes grey and slightly brighter, like a held frame
  float grey = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(grey) * 1.03 + 0.02, uTimeStop);

  // damage flash
  col += vec3(0.55, 0.05, 0.12) * uHit;

  // scanlines + vignette
  float scan = 1.0 - uScanline * 0.5 * (0.5 + 0.5 * sin(uv.y * uResolution.y * 3.14159));
  col *= scan;
  col *= 1.0 - uVignette * r2 * 1.15;

  // a whisper of grain so flat gradients do not band
  float grain = fract(sin(dot(uv * uResolution + uTime, vec2(12.9898, 78.233))) * 43758.5453);
  col += (grain - 0.5) * 0.018 * uGrain;

  // roll off only the highlights, so the darks stay deep
  col = mix(col, col / (col + vec3(0.75)) * 1.32, smoothstep(0.55, 1.15, max(col.r, max(col.g, col.b))));

  gl_FragColor = vec4(col, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(log || 'shader compile failed');
  }
  return s;
}

function program(gl, fragSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(log || 'program link failed');
  }
  return p;
}

function makeTarget(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo, w, h };
}

export class PostFX {
  constructor(displayCanvas, sceneCanvas) {
    this.display = displayCanvas;
    this.scene = sceneCanvas;
    this.ok = false;
    this.error = null;
    this.hit = 0;
    this.slowmo = 0;
    this.timeStop = 0;
    this.grain = 1;
    this.halation = 1;
    this.time = 0;
    this.compositeSource = DEFAULT_COMPOSITE;
    try { this.init(); } catch (e) { this.ok = false; this.error = String(e); }
    if (!this.ok) this.ctx2d = displayCanvas.getContext('2d');
  }

  init() {
    const gl = this.display.getContext('webgl', {
      alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.pBright = program(gl, FRAG_BRIGHT);
    this.pBlur = program(gl, FRAG_BLUR);
    this.pComposite = program(gl, DEFAULT_COMPOSITE);

    this.sceneTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const bw = Math.max(1, this.scene.width >> 1);
    const bh = Math.max(1, this.scene.height >> 1);
    this.rtA = makeTarget(gl, bw, bh);
    this.rtB = makeTarget(gl, bw, bh);
    this.ok = true;
  }

  // Returns null on success, or the compile error string.
  setComposite(src) {
    if (!this.ok) return 'WebGL unavailable';
    try {
      const p = program(this.gl, src);
      if (this.pComposite) this.gl.deleteProgram(this.pComposite);
      this.pComposite = p;
      this.compositeSource = src;
      return null;
    } catch (e) {
      return String(e.message || e);
    }
  }

  resetComposite() { return this.setComposite(DEFAULT_COMPOSITE); }

  drawQuad(prog) {
    const gl = this.gl;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  uni(prog, name) {
    this._cache = this._cache || new Map();
    const key = name + '@' + (prog.__id || (prog.__id = Math.random()));
    if (!this._cache.has(key)) this._cache.set(key, this.gl.getUniformLocation(prog, name));
    return this._cache.get(key);
  }

  render(dt) {
    this.time += dt;
    this.hit = Math.max(0, this.hit - dt * 3.2);
    if (!this.ok) {
      const c = this.ctx2d;
      c.imageSmoothingEnabled = false;
      c.clearRect(0, 0, this.display.width, this.display.height);
      c.drawImage(this.scene, 0, 0, this.display.width, this.display.height);
      return;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.scene);

    // bright pass into A
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.rtA.fbo);
    gl.viewport(0, 0, this.rtA.w, this.rtA.h);
    gl.useProgram(this.pBright);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.uniform1i(this.uni(this.pBright, 'uScene'), 0);
    gl.uniform1f(this.uni(this.pBright, 'uThreshold'), Theme.bloomThreshold);
    this.drawQuad(this.pBright);

    // blur A -> B -> A (three widening ping-pong iterations for a softer halo)
    for (let i = 0; i < 3; i++) {
      this.blurPass(this.rtA, this.rtB, 1 / this.rtA.w * (1 + i), 0);
      this.blurPass(this.rtB, this.rtA, 0, 1 / this.rtA.h * (1 + i));
    }

    // composite to screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.display.width, this.display.height);
    const p = this.pComposite;
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.uniform1i(this.uni(p, 'uScene'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.rtA.tex);
    gl.uniform1i(this.uni(p, 'uBloom'), 1);
    gl.uniform2f(this.uni(p, 'uResolution'), this.scene.width, this.scene.height);
    gl.uniform1f(this.uni(p, 'uTime'), this.time);
    gl.uniform1f(this.uni(p, 'uBloomStrength'), Theme.bloomStrength);
    gl.uniform1f(this.uni(p, 'uVignette'), Theme.vignette);
    gl.uniform1f(this.uni(p, 'uChroma'), Theme.chroma);
    gl.uniform1f(this.uni(p, 'uScanline'), Theme.scanline);
    gl.uniform1f(this.uni(p, 'uSaturation'), Theme.saturation);
    gl.uniform1f(this.uni(p, 'uHit'), this.hit);
    gl.uniform1f(this.uni(p, 'uSlowmo'), this.slowmo);
    gl.uniform1f(this.uni(p, 'uTimeStop'), this.timeStop);
    gl.uniform1f(this.uni(p, 'uGrain'), this.grain);
    gl.uniform1f(this.uni(p, 'uHalation'), this.halation);
    this.drawQuad(p);
    gl.activeTexture(gl.TEXTURE0);
  }

  blurPass(from, to, dx, dy) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, to.fbo);
    gl.viewport(0, 0, to.w, to.h);
    gl.useProgram(this.pBlur);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, from.tex);
    gl.uniform1i(this.uni(this.pBlur, 'uScene'), 0);
    gl.uniform2f(this.uni(this.pBlur, 'uDir'), dx, dy);
    this.drawQuad(this.pBlur);
  }
}

// Parse a .shdr pack: optional JSON theme header, then the GLSL composite.
export function parseShaderPack(text) {
  const res = { theme: {}, glsl: text.trim(), name: null };
  const m = text.match(/\/\*\s*@theme([\s\S]*?)@\*\//);
  if (m) {
    try {
      const cfg = JSON.parse(m[1].trim());
      res.theme = cfg;
      res.name = cfg.name || null;
    } catch (e) {
      throw new Error('Invalid @theme JSON: ' + e.message);
    }
    res.glsl = text.slice(m.index + m[0].length).trim();
  }
  if (!/gl_FragColor/.test(res.glsl)) {
    if (res.glsl.length === 0) return res;   // theme-only pack
    throw new Error('Shader must write to gl_FragColor');
  }
  return res;
}
