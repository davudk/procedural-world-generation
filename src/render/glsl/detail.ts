import { DN, type DetailParams } from '../height/heightFn';

/**
 * Close-zoom terrain detail, GLSL side (research 04 §2, 01 §4.6). Every constant comes from `DN` in
 * render/height/heightFn.ts, whose TS functions mirror these line by line (CPU picking agrees with
 * the rendered geometry). Integration: docs/research/06-m5-detail-integration.md.
 */

const u = (x: number): string => `0x${(x >>> 0).toString(16)}u`;
const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/**
 * Core: integer hash, precision-split value noise with analytic derivatives, damped/ridged fBm,
 * dunes, and raster samplers (bilinear / Catmull-Rom with gradient). Self-contained (no uniforms);
 * also used by the detail-map build passes.
 */
export const NOISE_GLSL = /* glsl */ `
const uint DN_M1 = ${u(DN.M1)};
const uint DN_M2 = ${u(DN.M2)};
const uint DN_M3 = ${u(DN.M3)};
const uint DN_F1 = ${u(DN.F1)};
const uint DN_F2 = ${u(DN.F2)};
const uint DN_OCT = ${u(DN.OCT)};
const uint DN_SEED_BAKE = ${u(DN.SEED_BAKE)};
const uint DN_SEED_DUNE = ${u(DN.SEED_DUNE)};
const float DN_TILE = ${f(DN.TILE)};
const int DN_TILE_BIAS = ${DN.TILE_BIAS};
const float DN_RIDGE_HI = ${f(DN.RIDGE_HI)};
const float DN_RIDGE_MAX = ${f(DN.RIDGE_MAX)};
const float DN_DAMP = ${f(DN.DAMP)};
const float DN_FADE_LO = ${f(DN.FADE_LO)};
const float DN_FADE_HI = ${f(DN.FADE_HI)};
const int DN_MAX_OCT = ${DN.MAX_OCT};
const float DN_AMP_BASE = ${f(DN.AMP_BASE)};
const float DN_AMP_ROUGH = ${f(DN.AMP_ROUGH)};
const float DN_DUNE_LX = ${f(DN.DUNE_LX)};
const float DN_DUNE_LY = ${f(DN.DUNE_LY)};
const float DN_DUNE_AMP = ${f(DN.DUNE_AMP)};
const float DN_DUNE_MEAN = ${f(DN.DUNE_MEAN)};
const float DN_DUNE_MAX = ${f(DN.DUNE_MAX)};
const float DN_SHORE_MARGIN = ${f(DN.SHORE_MARGIN)};
const float DN_BAKE_BASE = ${f(DN.BAKE_BASE)};
const float DN_BAKE_ROUGH = ${f(DN.BAKE_ROUGH)};
const float DN_DRY = ${f(DN.DRY)};

uint dnHash(ivec2 c, uint s) {
  uint h = (uint(c.x) * DN_M1) ^ (uint(c.y) * DN_M2) ^ (s * DN_M3);
  h ^= h >> 16u; h *= DN_F1; h ^= h >> 15u; h *= DN_F2; h ^= h >> 16u;
  return h;
}
float dnVal(ivec2 c, uint s) { return float(dnHash(c, s) >> 8u) * (2.0 / 16777216.0) - 1.0; }

// Value noise on a lattice of spacing lam (m, powers of two) at world point w; returns (n, dn/dx, dn/dy)
// per metre. w is split into a 65 536 m tile and a local offset before scaling (research 04 §1.6).
vec3 dnNoise(vec2 w, vec2 lam, uint s) {
  vec2 t = floor(w * (1.0 / DN_TILE));
  vec2 q = (w - t * DN_TILE) / lam;
  vec2 fq = floor(q);
  vec2 f = q - fq;
  ivec2 i = (ivec2(t) + DN_TILE_BIAS) * ivec2(DN_TILE / lam) + ivec2(fq);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = dnVal(i, s), b = dnVal(i + ivec2(1, 0), s), c = dnVal(i + ivec2(0, 1), s), d = dnVal(i + ivec2(1, 1), s);
  float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2(k1 + k4 * u.y, k2 + k4 * u.x) / lam);
}

// Derivative-damped, optionally ridged fBm faded per octave by footprint; |h| <= amp. Returns (h, grad).
vec3 dnFbm(vec2 w, float pxFoot, float lam0, int oct, float amp, float ridge, vec2 g0, uint seed) {
  vec3 acc = vec3(0.0);
  if (amp <= 0.0) return acc;
  float a = amp / (2.0 * (1.0 - exp2(-float(oct))) * DN_RIDGE_MAX);
  float lam = lam0;
  vec2 ds = g0;
  for (int k = 0; k < DN_MAX_OCT; k++) {
    if (k >= oct) break;
    float fw = 1.0 - smoothstep(DN_FADE_LO, DN_FADE_HI, pxFoot / lam);
    if (fw <= 0.0) break;
    vec3 n = dnNoise(w, vec2(lam), seed + uint(k) * DN_OCT);
    float sg = sign(n.x);
    n = mix(n, vec3(DN_RIDGE_HI - 2.0 * abs(n.x), -2.0 * sg * n.yz), ridge);
    float c = fw * a / (1.0 + DN_DAMP * dot(ds, ds));
    acc += c * n;
    ds += a * n.yz;   // ungated: fading an octave never changes the others
    a *= 0.5;
    lam *= 0.5;
  }
  return acc;
}

// Dune field, crests running north-south; |h| <= DN_DUNE_MAX * amp.
vec3 dnDunes(vec2 w, float pxFoot, float amp, uint seed) {
  if (amp <= 0.0) return vec3(0.0);
  float fw = 1.0 - smoothstep(DN_FADE_LO, DN_FADE_HI, pxFoot / DN_DUNE_LX);
  if (fw <= 0.0) return vec3(0.0);
  vec3 n = dnNoise(w, vec2(DN_DUNE_LX, DN_DUNE_LY), seed ^ DN_SEED_DUNE);
  float v = 1.0 - abs(n.x);
  float c = fw * amp;
  return c * vec3(v * v - DN_DUNE_MEAN, -2.0 * v * sign(n.x) * n.yz);
}

float dnFetch(sampler2D s, int n, ivec2 t) { return texelFetch(s, clamp(t, ivec2(0), ivec2(n - 1)), 0).r; }

// Bilinear value and texel-space gradient at texel coordinates q (integer q = texel centres).
vec3 dnBilinear(sampler2D s, int n, vec2 q) {
  ivec2 i = ivec2(floor(q));
  vec2 f = q - vec2(i);
  float a = dnFetch(s, n, i), b = dnFetch(s, n, i + ivec2(1, 0)), c = dnFetch(s, n, i + ivec2(0, 1)), d = dnFetch(s, n, i + ivec2(1, 1));
  float ab = mix(a, b, f.x), cd = mix(c, d, f.x);
  return vec3(mix(ab, cd, f.y), mix(b - a, d - c, f.y), mix(c - a, d - b, f.x));
}

vec4 dnCr(float t) { return vec4(((-0.5 * t + 1.0) * t - 0.5) * t, (1.5 * t - 2.5) * t * t + 1.0, ((-1.5 * t + 2.0) * t + 0.5) * t, (0.5 * t - 0.5) * t * t); }
vec4 dnCrd(float t) { return vec4((-1.5 * t + 2.0) * t - 0.5, (4.5 * t - 5.0) * t, (-4.5 * t + 4.0) * t + 0.5, (1.5 * t - 1.0) * t); }

// Catmull-Rom value and texel-space gradient; mm = min/max of the four nearest texels.
vec3 dnBicubic(sampler2D s, int n, vec2 q, out vec2 mm) {
  ivec2 i = ivec2(floor(q));
  vec2 f = q - vec2(i);
  vec4 wx = dnCr(f.x), wy = dnCr(f.y), dx = dnCrd(f.x), dy = dnCrd(f.y);
  float v = 0.0, gx = 0.0, gy = 0.0;
  mm = vec2(1e30, -1e30);
  for (int y = 0; y < 4; y++) {
    float rv = 0.0, rd = 0.0;
    for (int x = 0; x < 4; x++) {
      float h = dnFetch(s, n, i + ivec2(x - 1, y - 1));
      rv += wx[x] * h;
      rd += dx[x] * h;
      if (x >= 1 && x <= 2 && y >= 1 && y <= 2) mm = vec2(min(mm.x, h), max(mm.y, h));
    }
    v += wy[y] * rv;
    gx += wy[y] * rd;
    gy += dy[y] * rv;
  }
  return vec3(v, gx, gy);
}
`;

/**
 * Paste into BOTH the terrain VS and FS after HEIGHT_GLSL (uses u_height, u_hn, u_size, u_hasWater,
 * rawHeight, surfaceHeight, waterLevelAt). Provides:
 *   float detailWeight(float pxFoot)                 0..1 share of the detail map (0 at world zoom)
 *   vec3  detailSample(vec2 w, float pxFoot)         (h, dh/dx, dh/dy), raw elevation, world axes
 *   float terrainHeight(vec2 w, float pxFoot)        raw elevation (m)
 *   float terrainSurface(vec2 w, float pxFoot)       water lid max(h, water level)
 *   vec2  terrainGradient(vec2 w, float pxFoot)      dh/dx, dh/dy (x east, y north)
 * w = absolute world xy (m); pxFoot = metres per pixel at that point (VS: see the integration doc).
 */
export const DETAIL_GLSL = /* glsl */ `
${NOISE_GLSL}
uniform highp sampler2D u_detail;   // R32F detail elevation (m), row 0 = north
uniform sampler2D u_detailCtl;      // RGBA8 linear: roughness, rock, water/channel proximity, dunes
uniform int u_detailN;
uniform int u_hasDetail;
uniform uint u_detailSeed;
uniform float u_detailAmp;          // global multiplier (1 = default)
uniform float u_detailAmpScale;     // (lam0 / LAM_REF)^LAM_EXP
uniform float u_detailLam0;         // longest shader octave (m)
uniform int u_detailOct;

vec2 dnQ(vec2 w, int n) { return vec2(w.x, u_size - w.y) / u_size * float(n) - 0.5; }
vec3 dnToWorld(vec3 v, int n) { float k = float(n) / u_size; return vec3(v.x, v.y * k, -v.z * k); }
vec3 dnMacro(vec2 w) { return dnToWorld(dnBilinear(u_height, u_hn, dnQ(w, u_hn)), u_hn); }

float detailWeight(float pxFoot) {
  if (u_hasDetail == 0) return 0.0;
  float t = u_size / float(u_detailN);
  return 1.0 - smoothstep(t, 2.0 * t, pxFoot);
}

float detailWaterLevel(vec2 w) { return u_hasWater == 1 ? waterLevelAt(w) : 0.0; }

vec3 detailSample(vec2 w, float pxFoot) {
  float t = detailWeight(pxFoot);
  if (t <= 0.0) return dnMacro(w);
  float texel = u_size / float(u_detailN);
  vec2 q = dnQ(w, u_detailN);
  vec3 b = dnBilinear(u_detail, u_detailN, q);
  float tb = 1.0 - smoothstep(0.25 * texel, 0.5 * texel, pxFoot);
  if (tb > 0.0) {
    vec2 mm;
    vec3 c = dnBicubic(u_detail, u_detailN, q, mm);
    if (c.x < mm.x || c.x > mm.y) c = vec3(clamp(c.x, mm.x, mm.y), b.yz);
    b = mix(b, c, tb);
  }
  b = dnToWorld(b, u_detailN);
  if (t < 1.0) b = mix(dnMacro(w), b, t);
  if (pxFoot >= 0.5 * u_detailLam0) return b;
  vec4 ctl = textureLod(u_detailCtl, vec2(w.x, u_size - w.y) / u_size, 0.0);
  float amp = u_detailAmp * (DN_AMP_BASE + DN_AMP_ROUGH * ctl.r) * u_detailAmpScale * (1.0 - ctl.b);
  float dAmp = u_detailAmp * DN_DUNE_AMP * ctl.a * (1.0 - ctl.b);
  float wl = detailWaterLevel(w);
  float room = wl > DN_DRY ? abs(b.x - wl) - DN_SHORE_MARGIN : 1e9;
  float tot = amp + DN_DUNE_MAX * dAmp;
  float s = tot > 0.0 ? clamp(room / tot, 0.0, 1.0) : 0.0;
  b += dnFbm(w, pxFoot, u_detailLam0, u_detailOct, amp * s, ctl.g, b.yz, u_detailSeed);
  b += dnDunes(w, pxFoot, dAmp * s, u_detailSeed);
  return b;
}

float terrainHeight(vec2 w, float pxFoot) { return detailSample(w, pxFoot).x; }
vec2 terrainGradient(vec2 w, float pxFoot) { return detailSample(w, pxFoot).yz; }

float terrainSurface(vec2 w, float pxFoot) {
  float t = detailWeight(pxFoot);
  float s0 = t < 1.0 ? surfaceHeight(w) : 0.0;
  if (t <= 0.0) return s0;
  float h = terrainHeight(w, pxFoot);
  float wl = detailWaterLevel(w);
  float s = wl > DN_DRY ? max(h, wl) : max(h, 0.0);
  return mix(s0, s, t);
}
`;

/** What DetailUniforms needs from a detail map (DetailMap implements it). */
export interface DetailSource {
  readonly texture: WebGLTexture | null;
  readonly control: WebGLTexture;
  readonly ready: boolean;
  readonly params: DetailParams | null;
}

const NAMES = [
  'u_detail', 'u_detailCtl', 'u_detailN', 'u_hasDetail', 'u_detailSeed', 'u_detailAmp', 'u_detailAmpScale', 'u_detailLam0', 'u_detailOct',
] as const;
type Locs = Record<(typeof NAMES)[number], WebGLUniformLocation | null>;

/**
 * Binds DETAIL_GLSL's uniforms and two textures for a program. Call after gl.useProgram(prog), every
 * draw: `nextUnit = detailUniforms.bind(gl, prog, firstFreeUnit)`. Without a ready map it binds
 * 1×1 placeholders and sets u_hasDetail = 0 (identical to the pre-M5 renderer).
 */
export class DetailUniforms {
  map: DetailSource | null = null;
  /** Master switch (e.g. a debug toggle). */
  enabled = true;
  /** Shader amplification multiplier (u_detailAmp). Keep HeightFn.amp equal to it. */
  amp = 1;
  private readonly locs = new WeakMap<WebGLProgram, Locs>();
  private dummyF: WebGLTexture | null = null;
  private dummyC: WebGLTexture | null = null;

  constructor(map: DetailSource | null = null) {
    this.map = map;
  }

  /** True when the shader will use the detail map. */
  get active(): boolean {
    const m = this.map;
    return this.enabled && m !== null && m.ready && m.texture !== null && m.params !== null;
  }

  bind(gl: WebGL2RenderingContext, prog: WebGLProgram, firstTextureUnit: number): number {
    let l = this.locs.get(prog);
    if (!l) {
      l = {} as Locs;
      for (const n of NAMES) l[n] = gl.getUniformLocation(prog, n);
      this.locs.set(prog, l);
    }
    const on = this.active;
    const m = this.map;
    const p = on && m ? m.params! : null;
    gl.activeTexture(gl.TEXTURE0 + firstTextureUnit);
    gl.bindTexture(gl.TEXTURE_2D, on && m ? m.texture : this.dummy(gl, true));
    gl.uniform1i(l.u_detail, firstTextureUnit);
    gl.activeTexture(gl.TEXTURE0 + firstTextureUnit + 1);
    gl.bindTexture(gl.TEXTURE_2D, on && m ? m.control : this.dummy(gl, false));
    gl.uniform1i(l.u_detailCtl, firstTextureUnit + 1);
    gl.uniform1i(l.u_hasDetail, on ? 1 : 0);
    gl.uniform1i(l.u_detailN, p ? p.detailN : 1);
    gl.uniform1ui(l.u_detailSeed, p ? p.seed >>> 0 : 0);
    gl.uniform1f(l.u_detailAmp, this.amp);
    gl.uniform1f(l.u_detailAmpScale, p ? p.ampScale : 1);
    gl.uniform1f(l.u_detailLam0, p ? p.lam0 : 512);
    gl.uniform1i(l.u_detailOct, p ? p.octaves : 0);
    gl.activeTexture(gl.TEXTURE0);
    return firstTextureUnit + 2;
  }

  private dummy(gl: WebGL2RenderingContext, float: boolean): WebGLTexture {
    let t = float ? this.dummyF : this.dummyC;
    if (t) return t;
    t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array([0]));
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    if (float) this.dummyF = t;
    else this.dummyC = t;
    return t;
  }

  dispose(gl: WebGL2RenderingContext): void {
    if (this.dummyF) gl.deleteTexture(this.dummyF);
    if (this.dummyC) gl.deleteTexture(this.dummyC);
    this.dummyF = this.dummyC = null;
  }
}
