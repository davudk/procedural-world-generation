import { DN } from '../height/heightFn';
import { DG, type GlobeDetailParams, type TileLattice } from '../height/globeHeightFn';

/**
 * Close-zoom detail on the globe, GLSL side (Sphere phase 4b). Every function mirrors one in
 * render/height/globeHeightFn.ts line by line, and the constants are generated from `DN` / `DG`.
 */

const u = (x: number): string => `0x${(x >>> 0).toString(16)}u`;
const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/**
 * 3D integer-hash value noise and damped/ridged fBm on the sphere (self-contained, no uniforms; used by
 * the globe shaders and the tile build). A point is a 65 536 m lattice tile index plus a local offset,
 * so the arguments stay small anywhere on an Earth-sized planet.
 */
export const GLOBE_NOISE_GLSL = /* glsl */ `
const uint G_M1 = ${u(DN.M1)};
const uint G_M2 = ${u(DN.M2)};
const uint G_M3 = ${u(DN.M3)};
const uint G_M4 = ${u(DG.M4)};
const uint G_F1 = ${u(DN.F1)};
const uint G_F2 = ${u(DN.F2)};
const uint G_OCT = ${u(DN.OCT)};
const uint G_SEED_BAKE = ${u(DN.SEED_BAKE)};
const uint G_SEED_COAST = ${u(DG.SEED_COAST)};
const float G_TILE = ${f(DN.TILE)};
const float G_RIDGE_HI = ${f(DN.RIDGE_HI)};
const float G_RIDGE_MAX = ${f(DN.RIDGE_MAX)};
const float G_DAMP = ${f(DN.DAMP)};
const float G_FADE_LO = ${f(DN.FADE_LO)};
const float G_FADE_HI = ${f(DN.FADE_HI)};
const int G_MAX_OCT = ${DN.MAX_OCT};
const float G_AMP_BASE = ${f(DN.AMP_BASE)};
const float G_AMP_ROUGH = ${f(DN.AMP_ROUGH)};
const float G_SHORE_MARGIN = ${f(DN.SHORE_MARGIN)};
const float G_BAKE_BASE = ${f(DN.BAKE_BASE)};
const float G_BAKE_ROUGH = ${f(DN.BAKE_ROUGH)};
const float G_COAST_DISP = ${f(DG.COAST_DISP)};
const float G_COAST_MIN = ${f(DG.COAST_MIN)};
const float G_COAST_MAX = ${f(DG.COAST_MAX)};
const float G_COAST_RELAX = ${f(DG.COAST_RELAX)};

uint gHash(ivec3 c, uint s) {
  uint h = (uint(c.x) * G_M1) ^ (uint(c.y) * G_M2) ^ (uint(c.z) * G_M4) ^ (s * G_M3);
  h ^= h >> 16u; h *= G_F1; h ^= h >> 15u; h *= G_F2; h ^= h >> 16u;
  return h;
}
float gVal(ivec3 c, uint s) { return float(gHash(c, s) >> 8u) * (2.0 / 16777216.0) - 1.0; }

// Value noise at the point tile·G_TILE + l (m) on a lattice of spacing lam: (n, dn/dx, dn/dy, dn/dz) per metre.
vec4 gNoise(vec3 l, ivec3 tile, float lam, uint s) {
  vec3 q = l / lam;
  vec3 fq = floor(q);
  vec3 fr = q - fq;
  ivec3 i = tile * int(G_TILE / lam) + ivec3(fq);
  vec3 w = fr * fr * fr * (fr * (fr * 6.0 - 15.0) + 10.0);
  vec3 dw = 30.0 * fr * fr * (fr * (fr - 2.0) + 1.0);
  float a = gVal(i, s), b = gVal(i + ivec3(1, 0, 0), s), c = gVal(i + ivec3(0, 1, 0), s), d = gVal(i + ivec3(1, 1, 0), s);
  float e = gVal(i + ivec3(0, 0, 1), s), g = gVal(i + ivec3(1, 0, 1), s), h = gVal(i + ivec3(0, 1, 1), s), k = gVal(i + ivec3(1, 1, 1), s);
  float k1 = b - a, k2 = c - a, k3 = e - a, k4 = a - b - c + d, k5 = a - c - e + h, k6 = a - b - e + g;
  float k7 = -a + b + c - d + e - g - h + k;
  float n = a + k1 * w.x + k2 * w.y + k3 * w.z + k4 * w.x * w.y + k5 * w.y * w.z + k6 * w.z * w.x + k7 * w.x * w.y * w.z;
  vec3 gr = dw * vec3(k1 + k4 * w.y + k6 * w.z + k7 * w.y * w.z, k2 + k5 * w.z + k4 * w.x + k7 * w.z * w.x, k3 + k6 * w.x + k5 * w.y + k7 * w.x * w.y) / lam;
  return vec4(n, gr);
}

// Damped, ridged fBm on the sphere, faded per octave by footprint; gradients in the tangent plane at up.
vec4 gFbm(vec3 l, ivec3 tile, vec3 up, float pxFoot, float lam0, int oct, float amp, float ridge, vec3 g0, uint seed) {
  vec4 acc = vec4(0.0);
  if (amp <= 0.0) return acc;
  float a = amp / (2.0 * (1.0 - exp2(-float(oct))) * G_RIDGE_MAX);
  float lam = lam0;
  vec3 ds = g0;
  for (int k = 0; k < G_MAX_OCT; k++) {
    if (k >= oct) break;
    float fw = 1.0 - smoothstep(G_FADE_LO, G_FADE_HI, pxFoot / lam);
    if (fw <= 0.0) break;
    vec4 n = gNoise(l, tile, lam, seed + uint(k) * G_OCT);
    n.yzw -= dot(n.yzw, up) * up;
    vec3 un = n.yzw;
    float sg = sign(n.x);
    n = mix(n, vec4(G_RIDGE_HI - 2.0 * abs(n.x), -2.0 * sg * n.yzw), ridge);
    float c = fw * a / (1.0 + G_DAMP * dot(ds, ds));
    acc += c * n;
    // Ungated (fading an octave never changes the others), and unridged so damping is continuous at creases.
    ds += a * (1.0 + ridge) * un;
    a *= 0.5;
    lam *= 0.5;
  }
  return acc;
}

// fBm at an absolute planet-centred point (the tile build; float32 is ample for its >= 2-texel octaves).
vec4 gFbmAt(vec3 P, vec3 up, float pxFoot, float lam0, int oct, float amp, float ridge, vec3 g0, uint seed) {
  ivec3 tile = ivec3(floor(P / G_TILE));
  return gFbm(P - vec3(tile) * G_TILE, tile, up, pxFoot, lam0, oct, amp, ridge, g0, seed);
}
`;

/**
 * Paste into BOTH the globe VS and FS after CUBE_GLSL (uses u_height, u_hn, PAD, QUARTER, u_faceC/E/S,
 * heightAt and u_radius). Provides:
 *   float gDetailWeight(float pxFoot)                      0..1 share of the detail (0 at globe zoom)
 *   vec4  globeSample(int f, vec2 ang, vec3 rel, float pxFoot)   (h, 3D tangent gradient), raw elevation
 *   float globeSurface(int f, vec2 ang, vec3 rel, float pxFoot)  sea lid max(h, 0); = heightAt().y far out
 * rel = the sea-level point dir·R minus the eye (m); pxFoot = metres per pixel there.
 */
export const GLOBE_DETAIL_GLSL = /* glsl */ `
${GLOBE_NOISE_GLSL}
uniform highp sampler2DArray u_tiles;    // R32F tiles: core + margin, one layer per slot
uniform highp sampler2DArray u_tileIdx;  // RG32F, T x T per face layer: (slot or -1, fade)
uniform highp sampler2DArray u_gCtl;     // RGBA8 linear, padded like u_height: roughness, rock, water, -
uniform int u_gOn;
uniform int u_gTiles;
uniform int u_tN, u_tM, u_tT;
uniform float u_tDelta;
uniform float u_gTexel;
uniform uint u_gSeed;
uniform float u_gAmp, u_gAmpScale, u_gLam0;
uniform int u_gOct;
uniform ivec3 u_gTile;   // noise origin: the eye's 65 536 m lattice tile
uniform vec3 u_gOff;     // eye − tile·G_TILE (m)

const int G_B = ${DG.BLEND};

vec3 gChartGrad(int g, vec2 ang, vec2 gab) {
  vec2 t = tan(ang);
  float L2 = 1.0 + t.x * t.x + t.y * t.y;
  float L = sqrt(L2);
  float sa = (1.0 + t.x * t.x) / L, sb = (1.0 + t.y * t.y) / L;
  vec3 ta = u_radius * sa * vec3(1.0 - t.x * t.x / L2, -t.x * t.y / L2, -t.x / L2);
  vec3 tb = u_radius * sb * vec3(-t.x * t.y / L2, 1.0 - t.y * t.y / L2, -t.y / L2);
  float aa = dot(ta, ta), bb = dot(tb, tb), ab = dot(ta, tb);
  float det = aa * bb - ab * ab;
  vec3 lg = ((gab.x * bb - gab.y * ab) * ta + (gab.y * aa - gab.x * ab) * tb) / det;
  return lg.x * u_faceE[g] + lg.y * u_faceS[g] + lg.z * u_faceC[g];
}

int gFaceOfAxis(vec3 v) { return v.x > 0.5 ? 0 : v.y > 0.5 ? 1 : v.x < -0.5 ? 2 : v.y < -0.5 ? 3 : v.z > 0.5 ? 4 : 5; }
vec2 gChartAngles(int g, vec3 d) { float c = dot(d, u_faceC[g]); return vec2(atan(dot(d, u_faceE[g]), c), atan(dot(d, u_faceS[g]), c)); }
float gW1(float x) { float B = float(G_B), N = float(u_tN); return smoothstep(0.0, 1.0, (x + B) / (2.0 * B)) * smoothstep(0.0, 1.0, (N + B - x) / (2.0 * B)); }

float gDetailWeight(float pxFoot) { return u_gOn == 0 ? 0.0 : 1.0 - smoothstep(u_gTexel, 2.0 * u_gTexel, pxFoot); }

float gMacroFetch(ivec2 t, int f) { return texelFetch(u_height, ivec3(t, f), 0).r; }

// Bilinear raw macro (= heightAt(f, ang).x) and its tangent gradient.
vec4 gMacroBil(int f, vec2 ang) {
  float delta = 1.5707963267948966 / float(u_hn);
  int m = u_hn + 2 * PAD;
  vec2 p = clamp((ang + QUARTER) / delta - 0.5 + float(PAD), vec2(0.0), vec2(float(m) - 1.001));
  ivec2 i = ivec2(floor(p));
  vec2 fr = p - vec2(i);
  float a = gMacroFetch(i, f), b = gMacroFetch(i + ivec2(1, 0), f), c = gMacroFetch(i + ivec2(0, 1), f), d = gMacroFetch(i + ivec2(1, 1), f);
  float ab = mix(a, b, fr.x), cd = mix(c, d, fr.x);
  vec2 g = vec2(mix(b - a, d - c, fr.y), mix(c - a, d - b, fr.x));
  return vec4(mix(ab, cd, fr.y), gChartGrad(f, ang, g / delta));
}

vec4 gCr(float t) { return vec4(((-0.5 * t + 1.0) * t - 0.5) * t, (1.5 * t - 2.5) * t * t + 1.0, ((-1.5 * t + 2.0) * t + 0.5) * t, (0.5 * t - 0.5) * t * t); }
vec4 gCrd(float t) { return vec4((-1.5 * t + 2.0) * t - 0.5, (4.5 * t - 5.0) * t, (-4.5 * t + 4.0) * t + 0.5, (1.5 * t - 1.0) * t); }

// Catmull-Rom of the macro (the base where no tile is resident). Unclamped: clamping to the four nearest
// cells (as flat maps do) jumps where that set changes at cell edges; the tiles start from this cubic too.
vec4 gMacroCubic(int f, vec2 ang) {
  float delta = 1.5707963267948966 / float(u_hn);
  int m = u_hn + 2 * PAD;
  vec2 p = clamp((ang + QUARTER) / delta - 0.5 + float(PAD), vec2(1.0), vec2(float(m) - 2.001));
  ivec2 i = ivec2(floor(p));
  vec2 fr = p - vec2(i);
  vec4 wx = gCr(fr.x), wy = gCr(fr.y), dx = gCrd(fr.x), dy = gCrd(fr.y);
  float v = 0.0, gx = 0.0, gy = 0.0;
  for (int y = 0; y < 4; y++) {
    float rv = 0.0, rd = 0.0;
    for (int x = 0; x < 4; x++) {
      float h = gMacroFetch(i + ivec2(x - 1, y - 1), f);
      rv += wx[x] * h;
      rd += dx[x] * h;
    }
    v += wy[y] * rv;
    gx += wy[y] * rd;
    gy += dy[y] * rv;
  }
  return vec4(v, gChartGrad(f, ang, vec2(gx, gy) / delta));
}

float gTileFetch(ivec2 t, int slot) { int W = u_tN + 2 * u_tM; return texelFetch(u_tiles, ivec3(clamp(t, ivec2(0), ivec2(W - 1)), slot), 0).r; }

// Tile height and texel gradient at stored coordinates q (texel centres at integers): bilinear, and the
// Catmull-Rom blended in by tb (unclamped, so the surface stays continuous at texel edges).
vec3 gTileSample(int slot, vec2 q, float tb) {
  ivec2 i = ivec2(floor(q));
  vec2 fr = q - vec2(i);
  float a = gTileFetch(i, slot), b = gTileFetch(i + ivec2(1, 0), slot), c = gTileFetch(i + ivec2(0, 1), slot), d = gTileFetch(i + ivec2(1, 1), slot);
  vec3 r = vec3(mix(mix(a, b, fr.x), mix(c, d, fr.x), fr.y), mix(b - a, d - c, fr.y), mix(c - a, d - b, fr.x));
  if (tb > 0.0) {
    vec4 wx = gCr(fr.x), wy = gCr(fr.y), dx = gCrd(fr.x), dy = gCrd(fr.y);
    float v = 0.0, gx = 0.0, gy = 0.0;
    for (int y = 0; y < 4; y++) {
      float rv = 0.0, rd = 0.0;
      for (int x = 0; x < 4; x++) {
        float h = gTileFetch(i + ivec2(x - 1, y - 1), slot);
        rv += wx[x] * h;
        rd += dx[x] * h;
      }
      v += wy[y] * rv;
      gx += wy[y] * rd;
      gy += dy[y] * rv;
    }
    r = mix(r, vec3(v, gx, gy), tb);
  }
  return r;
}

// Resident tiles blended by partition-of-unity weights (each in its own face chart); the Catmull-Rom macro takes the share of missing or fading tiles.
vec4 gTileBase(int f, vec2 ang, vec3 dir, float pxFoot) {
  vec4 fb = gMacroCubic(f, ang);
  if (u_gTiles == 0) return fb;
  int N = u_tN, T = u_tT, F = u_tN * u_tT;
  float B = float(G_B);
  float tb = 1.0 - smoothstep(0.25 * u_gTexel, 0.5 * u_gTexel, pxFoot);
  float wsum = 0.0, wres = 0.0;
  vec4 acc = vec4(0.0);
  vec2 pf = (ang + QUARTER) / u_tDelta;
  for (int side = -1; side < 4; side++) {
    int g = f;
    vec2 ga = ang;
    if (side >= 0) {
      bool nearEdge = side == 0 ? pf.x < B : side == 1 ? pf.x > float(F) - B : side == 2 ? pf.y < B : pf.y > float(F) - B;
      if (!nearEdge) continue;
      float sg = (side == 0 || side == 2) ? -1.0 : 1.0;
      g = gFaceOfAxis(sg * (side < 2 ? u_faceE[f] : u_faceS[f]));
      ga = gChartAngles(g, dir);
    }
    vec2 p = (ga + QUARTER) / u_tDelta;
    ivec2 i0 = max(ivec2(0), ivec2(floor((p - B) / float(N))));
    ivec2 i1 = min(ivec2(T - 1), ivec2(floor((p + B) / float(N))));
    for (int iy = i0.y; iy <= i1.y; iy++) {
      for (int ix = i0.x; ix <= i1.x; ix++) {
        vec2 uv = p - vec2(float(ix * N), float(iy * N));
        float w = gW1(uv.x) * gW1(uv.y);
        if (w <= 0.0) continue;
        wsum += w;
        vec2 sf = texelFetch(u_tileIdx, ivec3(ix, iy, g), 0).rg;
        if (sf.x < 0.0 || sf.y <= 0.0) continue;
        vec3 s = gTileSample(int(sf.x + 0.5), uv + float(u_tM) - 0.5, tb);
        float wf = w * sf.y;
        wres += wf;
        acc += wf * vec4(s.x, gChartGrad(g, ga, s.yz / u_tDelta));
      }
    }
  }
  if (wres <= 0.0 || wsum <= 0.0) return fb;
  return (acc + (wsum - wres) * fb) / wsum;
}

vec4 globeSample(int f, vec2 ang, vec3 rel, float pxFoot) {
  vec4 m = gMacroBil(f, ang);
  float t = gDetailWeight(pxFoot);
  if (t <= 0.0) return m;
  vec3 dir = faceDirOf(f, ang);
  vec4 b = gTileBase(f, ang, dir, pxFoot);
  if (t < 1.0) b = mix(m, b, t);
  if (pxFoot >= 0.5 * u_gLam0) return b;
  float delta = 1.5707963267948966 / float(u_hn);
  float mm = float(u_hn + 2 * PAD);
  vec4 ctl = textureLod(u_gCtl, vec3(((ang + QUARTER) / delta + float(PAD)) / mm, float(f)), 0.0);
  float amp = u_gAmp * (G_AMP_BASE + G_AMP_ROUGH * ctl.r) * u_gAmpScale * (1.0 - ctl.b);
  float room = abs(b.x) - G_SHORE_MARGIN;
  float s = amp > 0.0 ? clamp(room / amp, 0.0, 1.0) : 0.0;
  b += gFbm(u_gOff + rel, u_gTile, dir, pxFoot, u_gLam0, u_gOct, amp * s, ctl.g, b.yzw, u_gSeed);
  return b;
}

float globeSurface(int f, vec2 ang, vec3 rel, float pxFoot) {
  float t = gDetailWeight(pxFoot);
  float s0 = t < 1.0 ? heightAt(f, ang).y : 0.0;
  if (t <= 0.0) return s0;
  float h = globeSample(f, ang, rel, pxFoot).x;
  return mix(s0, max(h, 0.0), t);
}
`;

/** What GlobeDetailUniforms needs from the detail system (GlobeDetail implements it). */
export interface GlobeDetailSource {
  readonly params: GlobeDetailParams | null;
  readonly lattice: TileLattice | null;
  readonly controlTex: WebGLTexture | null;
  readonly tileTex: WebGLTexture | null;
  readonly idxTex: WebGLTexture | null;
  /** Number of resident tiles (0: tiles are skipped in the shader). */
  readonly residentCount: number;
}

const NAMES = [
  'u_tiles', 'u_tileIdx', 'u_gCtl', 'u_gOn', 'u_gTiles', 'u_tN', 'u_tM', 'u_tT', 'u_tDelta', 'u_gTexel', 'u_gSeed', 'u_gAmp',
  'u_gAmpScale', 'u_gLam0', 'u_gOct', 'u_gTile', 'u_gOff',
] as const;
type Locs = Record<(typeof NAMES)[number], WebGLUniformLocation | null>;

/**
 * Binds GLOBE_DETAIL_GLSL's uniforms and three texture arrays for a program, after gl.useProgram:
 * `next = u.bind(gl, prog, firstUnit, eye)`. Without detail it binds 1×1 placeholders and sets
 * u_gOn = 0, which renders exactly as the phase-3 globe.
 */
export class GlobeDetailUniforms {
  src: GlobeDetailSource | null = null;
  enabled = true;
  /** Shader amplification multiplier (keep GlobeHeightFn.amp equal to it). */
  amp = 1;
  private readonly locs = new WeakMap<WebGLProgram, Locs>();
  private dummyF: WebGLTexture | null = null;
  private dummyRG: WebGLTexture | null = null;
  private dummyC: WebGLTexture | null = null;

  get active(): boolean {
    const s = this.src;
    return this.enabled && s !== null && s.params !== null && s.controlTex !== null;
  }

  bind(gl: WebGL2RenderingContext, prog: WebGLProgram, unit: number, eye: { x: number; y: number; z: number }): number {
    let l = this.locs.get(prog);
    if (!l) {
      l = {} as Locs;
      for (const n of NAMES) l[n] = gl.getUniformLocation(prog, n);
      this.locs.set(prog, l);
    }
    const s = this.active ? this.src : null;
    const p = s?.params ?? null;
    const lat = s?.lattice ?? null;
    const tiles = s !== null && lat !== null && s.residentCount > 0 && s.tileTex !== null && s.idxTex !== null;
    const bindArr = (k: number, tex: WebGLTexture, loc: WebGLUniformLocation | null): void => {
      gl.activeTexture(gl.TEXTURE0 + unit + k);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      gl.uniform1i(loc, unit + k);
    };
    bindArr(0, tiles ? s.tileTex! : this.dummy(gl, 'f'), l.u_tiles);
    bindArr(1, tiles ? s.idxTex! : this.dummy(gl, 'rg'), l.u_tileIdx);
    bindArr(2, s?.controlTex ?? this.dummy(gl, 'c'), l.u_gCtl);
    gl.uniform1i(l.u_gOn, p ? 1 : 0);
    gl.uniform1i(l.u_gTiles, tiles ? 1 : 0);
    gl.uniform1i(l.u_tN, lat ? lat.N : 1);
    gl.uniform1i(l.u_tM, lat ? lat.M : 0);
    gl.uniform1i(l.u_tT, lat ? lat.T : 1);
    gl.uniform1f(l.u_tDelta, lat ? lat.delta : 1);
    gl.uniform1f(l.u_gTexel, p ? p.texelM : 1);
    gl.uniform1ui(l.u_gSeed, p ? p.seed >>> 0 : 0);
    gl.uniform1f(l.u_gAmp, this.amp);
    gl.uniform1f(l.u_gAmpScale, p ? p.ampScale : 1);
    gl.uniform1f(l.u_gLam0, p ? p.lam0 : 512);
    gl.uniform1i(l.u_gOct, p ? p.octaves : 0);
    const [tile, off] = noiseOrigin(eye);
    gl.uniform3i(l.u_gTile, tile[0], tile[1], tile[2]);
    gl.uniform3f(l.u_gOff, off[0], off[1], off[2]);
    gl.activeTexture(gl.TEXTURE0);
    return unit + 3;
  }

  private dummy(gl: WebGL2RenderingContext, kind: 'f' | 'rg' | 'c'): WebGLTexture {
    const have = kind === 'f' ? this.dummyF : kind === 'rg' ? this.dummyRG : this.dummyC;
    if (have) return have;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    if (kind === 'f') gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R32F, 1, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array(1));
    else if (kind === 'rg') gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RG32F, 1, 1, 6, 0, gl.RG, gl.FLOAT, new Float32Array(12).fill(-1));
    else gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, 1, 1, 6, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(24));
    if (kind === 'f') this.dummyF = t;
    else if (kind === 'rg') this.dummyRG = t;
    else this.dummyC = t;
    return t;
  }

  dispose(gl: WebGL2RenderingContext): void {
    for (const t of [this.dummyF, this.dummyRG, this.dummyC]) if (t) gl.deleteTexture(t);
    this.dummyF = this.dummyRG = this.dummyC = null;
  }
}

/** Noise origin for an eye position (float64): the 65 536 m lattice tile and the eye's offset in it. */
export function noiseOrigin(eye: { x: number; y: number; z: number }): [[number, number, number], [number, number, number]] {
  const t = [Math.floor(eye.x / DN.TILE), Math.floor(eye.y / DN.TILE), Math.floor(eye.z / DN.TILE)] as [number, number, number];
  return [t, [eye.x - t[0] * DN.TILE, eye.y - t[1] * DN.TILE, eye.z - t[2] * DN.TILE]];
}
