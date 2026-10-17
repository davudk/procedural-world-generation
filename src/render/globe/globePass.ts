import { BIOME } from '../../shared/biomes';
import type { Layer, LayerKind } from '../../shared/protocol';
import { compileProgram, uniforms } from '../gl/util';
import { COLORMAPS_GLSL } from '../glsl/colormaps';
import { buildBiomeLut, LUT_SIZE, type Palette } from '../terrain/biomeLut';
import { GRID } from '../terrain/cdlod';
import { SPHERE_INSTANCE_FLOATS, SPHERE_MAX_NODES } from '../terrain/cdlodSphere';
import { bindGlobeAtmos, GLOBE_ATMOS_GLSL, type GlobeAtmosFrame } from './atmosphere';
import { GLOBE_DETAIL_GLSL, type GlobeDetailUniforms } from '../glsl/globeDetail';
import { DG } from '../height/globeHeightFn';

const f1 = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);
import type { Vec3 } from '../camera/ground';
import { FACE_C, FACE_E, FACE_S, faceDir } from '../../shared/cube';
import { acrossCell, arrayTexture, PAD, padFaces, SIDE_E, SIDE_N, SIDE_S, SIDE_W, uploadArray } from './cubeTex';
import type { GlobeHeightField } from './globeGround';

/** Cube-face addressing shared by the globe's vertex and fragment shaders. */
const CUBE_GLSL = /* glsl */ `
#define PAD ${PAD}
#define QUARTER 0.7853981633974483
uniform vec3 u_faceC[6];
uniform vec3 u_faceE[6];
uniform vec3 u_faceS[6];
uniform highp sampler2DArray u_height;   // R32F raw elevation (m), 6 padded layers
uniform highp sampler2DArray u_surf;     // R32F rendered surface (m): the water lid max(h, water level)
uniform int u_hn;                        // cells per face side

vec3 faceDirOf(int f, vec2 ang) {
  vec2 t = tan(ang);
  return normalize(u_faceC[f] + t.x * u_faceE[f] + t.y * u_faceS[f]);
}

// Hand-filtered bilinear over the padded layers: never leaves the face's texture layer.
// w.x = raw elevation, w.y = rendered surface (the sea at 0, lakes at their level).
vec2 heightAt(int f, vec2 ang) {
  float delta = 1.5707963267948966 / float(u_hn);
  int m = u_hn + 2 * PAD;
  vec2 p = clamp((ang + QUARTER) / delta - 0.5 + float(PAD), vec2(0.0), vec2(float(m) - 1.001));
  ivec2 i = ivec2(floor(p));
  vec2 fr = p - vec2(i);
  float a = texelFetch(u_height, ivec3(i, f), 0).r;
  float b = texelFetch(u_height, ivec3(i + ivec2(1, 0), f), 0).r;
  float c = texelFetch(u_height, ivec3(i + ivec2(0, 1), f), 0).r;
  float d = texelFetch(u_height, ivec3(i + ivec2(1, 1), f), 0).r;
  float raw = mix(mix(a, b, fr.x), mix(c, d, fr.x), fr.y);
  float sa = texelFetch(u_surf, ivec3(i, f), 0).r;
  float sb = texelFetch(u_surf, ivec3(i + ivec2(1, 0), f), 0).r;
  float sc = texelFetch(u_surf, ivec3(i + ivec2(0, 1), f), 0).r;
  float sd = texelFetch(u_surf, ivec3(i + ivec2(1, 1), f), 0).r;
  float s = mix(mix(sa, sb, fr.x), mix(sc, sd, fr.x), fr.y);
  return vec2(raw, s);
}

uniform highp sampler2DArray u_wlevel;  // R32F padded water level (m, < −9000 dry), spread 2 rings past the shore
uniform highp sampler2DArray u_wclass;  // R32F padded water class (0 land, 1 ocean, 2 lake, 3 river, 4 wetland, 5 playa, 6 salt lake)
uniform int u_hasWater;
// Water level (bilinear, as the flat terrain's waterLevelAt) and class (nearest) on the height grid.
float waterLevelAt(int f, vec2 ang) {
  float delta = 1.5707963267948966 / float(u_hn);
  int m = u_hn + 2 * PAD;
  vec2 p = clamp((ang + QUARTER) / delta - 0.5 + float(PAD), vec2(0.0), vec2(float(m) - 1.001));
  ivec2 i = ivec2(floor(p));
  vec2 fr = p - vec2(i);
  float a = texelFetch(u_wlevel, ivec3(i, f), 0).r;
  float b = texelFetch(u_wlevel, ivec3(i + ivec2(1, 0), f), 0).r;
  float c = texelFetch(u_wlevel, ivec3(i + ivec2(0, 1), f), 0).r;
  float d = texelFetch(u_wlevel, ivec3(i + ivec2(1, 1), f), 0).r;
  return mix(mix(a, b, fr.x), mix(c, d, fr.x), fr.y);
}
float waterClassAt(int f, vec2 ang) {
  float delta = 1.5707963267948966 / float(u_hn);
  ivec2 t = ivec2(floor((ang + QUARTER) / delta)) + PAD;
  return texelFetch(u_wclass, ivec3(clamp(t, ivec2(0), ivec2(u_hn + 2 * PAD - 1)), f), 0).r;
}
// Water level the close-zoom detail respects (globeDetail.ts): the prepared levels without river cells
// (rivers are ribbons over carved channels; their levels would flood the detailed valley floors), or the
// sea at 0. Same addressing as waterLevelAt.
uniform highp sampler2DArray u_wlevelD;
uniform highp sampler2DArray u_wetD;   // R32F padded real-water mask (cells with their own level, not rivers)
float gWaterLevel(int f, vec2 ang) {
  if (u_hasWater == 0) return 0.0;
  float delta = 1.5707963267948966 / float(u_hn);
  int m = u_hn + 2 * PAD;
  vec2 p = clamp((ang + QUARTER) / delta - 0.5 + float(PAD), vec2(0.0), vec2(float(m) - 1.001));
  ivec2 i = ivec2(floor(p));
  vec2 fr = p - vec2(i);
  float a = texelFetch(u_wlevelD, ivec3(i, f), 0).r;
  float b = texelFetch(u_wlevelD, ivec3(i + ivec2(1, 0), f), 0).r;
  float c = texelFetch(u_wlevelD, ivec3(i + ivec2(0, 1), f), 0).r;
  float d = texelFetch(u_wlevelD, ivec3(i + ivec2(1, 1), f), 0).r;
  float wl = mix(mix(a, b, fr.x), mix(c, d, fr.x), fr.y);
  if (wl <= -9000.0) return wl;
  a = texelFetch(u_wetD, ivec3(i, f), 0).r;
  b = texelFetch(u_wetD, ivec3(i + ivec2(1, 0), f), 0).r;
  c = texelFetch(u_wetD, ivec3(i + ivec2(0, 1), f), 0).r;
  d = texelFetch(u_wetD, ivec3(i + ivec2(1, 1), f), 0).r;
  float wet = mix(mix(a, b, fr.x), mix(c, d, fr.x), fr.y);
  return wl - ${f1(DG.WET_DROP)} * (1.0 - clamp(wet / ${f1(DG.WET_FADE)}, 0.0, 1.0));   // = globeHeightFn.wetLevel
}`;

const VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec2 a_grid;     // 0..GRID
layout(location = 1) in vec4 a_node;     // face, centre angles a and b, size (rad)
layout(location = 2) in vec3 a_centre;   // node centre at sea level, relative to the eye (m, from float64)
layout(location = 3) in vec3 a_lod;      // level, morph start, morph end (m)
uniform mat4 u_viewProj;
uniform float u_radius;
uniform float u_exag;
uniform float u_pxScale;   // 2·tan(fovY/2) / viewport height: metres per pixel per metre of distance
${CUBE_GLSL}
${GLOBE_DETAIL_GLSL}
${GLOBE_ATMOS_GLSL}
out vec2 v_ang;
flat out int v_face;
out vec3 v_rel;
out vec3 v_relSea;   // the sea-level point dir·R relative to the eye (noise argument, precise)
out vec3 v_air;     // aerial perspective: in-scattered light and transmittance, per vertex (smooth)
out vec3 v_trans;

// Offset of the direction at angles c0 + off from the node centre's direction, in a form without
// large cancellations: tan(a) − tan(a0) = sin(a − a0) / (cos a · cos a0), and
// F/|F| − F0/|F0| = dF/L − F0 (2 F0·dF + dF·dF) / (L L0 (L + L0)).
vec3 dirOffset(int f, vec2 c0, vec2 off, vec3 F0, float L0) {
  vec2 dXY = sin(off) / (cos(c0 + off) * cos(c0));
  vec3 dF = dXY.x * u_faceE[f] + dXY.y * u_faceS[f];
  float L = length(F0 + dF);
  float q = 2.0 * dot(F0, dF) + dot(dF, dF);
  return dF / L - F0 * (q / (L * L0 * (L + L0)));
}

void main() {
  int f = int(a_node.x + 0.5);
  vec2 c0 = a_node.yz;
  float S = a_node.w;
  vec2 t0 = tan(c0);
  vec3 F0 = u_faceC[f] + t0.x * u_faceE[f] + t0.y * u_faceS[f];
  float L0 = length(F0);
  vec3 dir0 = F0 / L0;
  // Unmorphed position for the morph distance.
  vec2 offA = (a_grid / ${GRID}.0 - 0.5) * S;
  vec3 ddA = dirOffset(f, c0, offA, F0, L0);
  float hA = heightAt(f, c0 + offA).y * u_exag;
  float d0 = length(a_centre + u_radius * ddA + hA * (dir0 + ddA));
  float k = clamp((d0 - a_lod.y) / (a_lod.z - a_lod.y), 0.0, 1.0);
  vec2 g = a_grid - fract(a_grid * 0.5) * 2.0 * k;
  vec2 off = (g / ${GRID}.0 - 0.5) * S;
  vec3 dd = dirOffset(f, c0, off, F0, L0);
  vec2 ang = c0 + off;
  vec3 relSea = a_centre + u_radius * dd;
  // Geometry can't hold wavelengths under ~2 vertex spacings: the footprint is at least the spacing and
  // grows with the morph, so detail octaves fade together with vertex snapping (as on flat maps).
  float foot = max(d0 * u_pxScale, S * u_radius / ${GRID}.0 * (1.0 + k));
  float h = (u_gOn == 1 ? globeSurface(f, ang, relSea, foot) : heightAt(f, ang).y) * u_exag;
  vec3 rel = relSea + h * (dir0 + dd);
  v_ang = ang;
  v_face = f;
  v_rel = rel;
  v_relSea = relSea;
  vec3 trans;
  v_air = atmosphere(u_eyeP, normalize(rel), length(rel), 8, trans);
  v_trans = trans;
  gl_Position = u_viewProj * vec4(rel, 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
in vec2 v_ang;
flat in int v_face;
in vec3 v_rel;
in vec3 v_relSea;
in vec3 v_air;
in vec3 v_trans;
uniform float u_radius;
uniform float u_exag;
uniform float u_normalExag;
uniform sampler2DArray u_grad;     // RGBA16F + mips, unpadded: 3D surface gradient (planet axes)
uniform sampler2DArray u_climate;  // RGBA16F padded: mean T (°C), aridity (biome stage, else a proxy), summer rain share, half-range (°C)
uniform int u_cn;                  // climate cells per face side
uniform int u_hasClimate;
uniform sampler2DArray u_cover;    // RGBA8 padded (climate grid): snow/ice, bare rock, sand (beach, salt flat, erg), marsh/bog/mangrove
uniform int u_hasCover;            // 1 once the biome stage exists (else the climate proxy colours)
uniform sampler2D u_lut;
uniform int u_palette;             // 0 biome LUT colours, 1 hypsometric
uniform sampler2DArray u_layer;    // padded draped layer
uniform int u_ln;
uniform int u_layerMode;           // 0 realistic, 1 categorical, 2 scalar
uniform float u_layerMin, u_layerMax;
uniform vec3 u_sunCarto;           // cartographic sun in (screen right, screen up, local up) coordinates
uniform vec3 u_camRight, u_camUp;  // camera axes (planet axes)
uniform vec3 u_sunReal;            // unit vector toward the real sun
uniform float u_realK;             // 0 near the surface (cartographic light), 1 at globe zoom (real sun)
uniform vec3 u_lightCol, u_ambient;   // light colours at the target (from the sun model)
uniform int u_realistic;
uniform vec2 u_season;             // seasonal phase (cos, sin); (1, 0) at the warm peak
uniform float u_time;
${CUBE_GLSL}
${GLOBE_DETAIL_GLSL}
${COLORMAPS_GLSL}
out vec4 o;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
// 3D value noise: continuous across face seams (the cube faces' 2D coordinates are not).
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
    mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + 1.0), u.x), u.y),
    u.z);
}

// Cubic B-spline of the raw elevation over 4×4 padded texels (PAD = 2 covers it at face edges):
// rounds the 2 km cells' stair-step coastlines when they are many pixels wide.
float heightSmooth(int f, vec2 ang) {
  float delta = 1.5707963267948966 / float(u_hn);
  int m = u_hn + 2 * PAD;
  vec2 p = clamp((ang + QUARTER) / delta - 0.5 + float(PAD), vec2(1.0), vec2(float(m) - 2.001));
  ivec2 i = ivec2(floor(p));
  vec2 t = p - vec2(i);
  vec2 s = 1.0 - t;
  vec2 w0 = s * s * s / 6.0;
  vec2 w1 = (4.0 - 6.0 * t * t + 3.0 * t * t * t) / 6.0;
  vec2 w2 = (4.0 - 6.0 * s * s + 3.0 * s * s * s) / 6.0;
  vec2 w3 = t * t * t / 6.0;
  float acc = 0.0;
  for (int y = 0; y < 4; y++) {
    float wy = y == 0 ? w0.y : y == 1 ? w1.y : y == 2 ? w2.y : w3.y;
    float row = 0.0;
    for (int x = 0; x < 4; x++) {
      float wx = x == 0 ? w0.x : x == 1 ? w1.x : x == 2 ? w2.x : w3.x;
      row += wx * texelFetch(u_height, ivec3(i + ivec2(x - 1, y - 1), f), 0).r;
    }
    acc += wy * row;
  }
  return acc;
}

vec4 climateAt(int f, vec2 ang) {
  float delta = 1.5707963267948966 / float(u_cn);
  float m = float(u_cn + 2 * PAD);
  vec2 p = ((ang + QUARTER) / delta + float(PAD)) / m;
  return texture(u_climate, vec3(p, float(f)));
}
vec4 coverAt(int f, vec2 ang) {
  float delta = 1.5707963267948966 / float(u_cn);
  float m = float(u_cn + 2 * PAD);
  vec2 p = ((ang + QUARTER) / delta + float(PAD)) / m;
  return texture(u_cover, vec3(p, float(f)));
}
float layerFetch(ivec2 t, int f) { return texelFetch(u_layer, ivec3(clamp(t, ivec2(0), ivec2(u_ln + 2 * PAD - 1)), f), 0).r; }
float layerAt(int f, vec2 ang, bool nearest) {
  float delta = 1.5707963267948966 / float(u_ln);
  vec2 p = (ang + QUARTER) / delta + float(PAD);
  if (nearest) return layerFetch(ivec2(floor(p)), f);
  p -= 0.5;
  ivec2 i = ivec2(floor(p));
  vec2 fr = p - vec2(i);
  return mix(mix(layerFetch(i, f), layerFetch(i + ivec2(1, 0), f), fr.x), mix(layerFetch(i + ivec2(0, 1), f), layerFetch(i + ivec2(1, 1), f), fr.x), fr.y);
}

// Sun model colours for a local sun elevation (sine mu), as lighting/sun.ts at that elevation.
void dayLight(float mu, out vec3 light, out vec3 amb) {
  float day = smoothstep(-0.05, 0.08, mu);
  float warm = 1.0 - smoothstep(0.05, 0.45, mu);
  float night = 1.0 - smoothstep(-0.12, 0.0, mu);
  light = mix(vec3(1.0), vec3(1.0, 0.62, 0.36), warm) * day * (1.0 - 0.3 * warm) + vec3(0.55, 0.68, 1.0) * 0.22 * night * 0.5;
  float fill = 1.0 + 0.5 * warm * day;
  amb = mix(vec3(0.10, 0.13, 0.24) * 0.6, mix(vec3(fill), vec3(1.08, 0.92, 0.86) * fill, warm * day), smoothstep(-0.14, 0.25, mu));
}

void main() {
  int f = v_face;
  vec2 ang = v_ang;
  vec3 up = faceDirOf(f, ang);
  vec2 hs = heightAt(f, ang);
  float delta = 1.5707963267948966 / float(u_hn);
  float texelsPerPx = length(fwidth(ang)) / delta;
  // Close up, smooth the cell structure of the coast (bilinear far out, where cells are a few px).
  float smoothK = 1.0 - smoothstep(0.08, 0.25, texelsPerPx);
  float pxFoot = length(fwidth(v_rel));
  // Close-zoom detail (streamed tiles + 3D octaves) replaces the B-spline rounding when it exists.
  float tD = gDetailWeight(pxFoot);
  vec4 ds = tD > 0.0 ? globeSample(f, ang, v_relSea, pxFoot) : vec4(hs.x, 0.0, 0.0, 0.0);
  float h = u_gOn == 1 ? ds.x : smoothK > 0.0 ? mix(hs.x, heightSmooth(f, ang), smoothK) : hs.x;
  // Water: the sea, plus lakes from the hydrology stage's levels (as the flat terrain's water lid).
  // With detail the level fades to the riverless one the detailed surface was built against.
  float wl = u_hasWater == 1 ? mix(waterLevelAt(f, ang), gWaterLevel(f, ang), tD) : -10000.0;
  float cls = u_hasWater == 1 ? waterClassAt(f, ang) : 0.0;
  // Lakes by class, or by a level above the sea where the spread rings meet other classes.
  bool lake = cls > 1.5 && cls < 2.5 || cls > 5.5 || wl > 0.05;
  // Every class but river cells (drawn as ribbons): coastal wetland or beach cells reached by the
  // spread sea level keep a smooth shoreline instead of the nearest class's cell outline.
  bool water = u_hasWater == 1 ? wl > h && !(cls > 2.5 && cls < 3.5) : h < 0.0;
  // Mipmapped gradient: smooth normals, no aliasing when cells are smaller than a pixel.
  vec3 grad = textureLod(u_grad, vec3((ang + QUARTER) / 1.5707963267948966, float(f)), max(0.0, log2(max(texelsPerPx, 1e-6)) - 0.5)).xyz;
  grad -= dot(grad, up) * up;
  if (tD > 0.0) grad = mix(grad, ds.yzw, tD);
  vec3 n = normalize(up - grad * u_normalExag);

  // Light: the screen-relative cartographic sun in every pixel's own tangent frame, blended to the real sun.
  vec3 rt = normalize(u_camRight - dot(u_camRight, up) * up);
  vec3 ut = normalize(u_camUp - dot(u_camUp, up) * up);
  vec3 Lc = normalize(u_sunCarto.x * rt + u_sunCarto.y * ut + u_sunCarto.z * up);
  vec3 L = normalize(mix(Lc, u_sunReal, u_realK));
  vec3 lightCol = u_lightCol, amb = u_ambient;
  if (u_realK > 0.0) {
    vec3 lr, ar;
    dayLight(dot(up, u_sunReal), lr, ar);
    lightCol = mix(lightCol, lr, u_realK);
    amb = mix(amb, ar, u_realK);
  }

  vec3 V = normalize(-v_rel);
  vec3 P = up * (u_radius + hs.y * u_exag);
  vec4 cl = u_hasClimate == 1 ? climateAt(f, ang) : vec4(15.0, 1.0, 0.5, 10.0);
  float tNow = cl.r + cl.a * u_season.x;
  vec3 col;
  if (water && u_layerMode == 0) {
    float depth = lake ? max(0.0, wl - h) : -h;
    vec3 shallow = lake ? vec3(0.22, 0.48, 0.52) : vec3(0.24, 0.56, 0.62);
    vec3 deep = lake ? vec3(0.05, 0.16, 0.24) : vec3(0.03, 0.10, 0.22);
    col = mix(shallow, deep, pow(clamp(depth / (lake ? 400.0 : 4000.0), 0.0, 1.0), 0.35));
    col = mix(col, vec3(0.42, 0.68, 0.70), (1.0 - smoothstep(0.0, lake ? 15.0 : 60.0, depth)) * 0.6);
    // Sea and lake ice where the water is cold now (lakes freeze sooner).
    float ice = u_hasClimate == 1 && u_realistic == 1 ? (lake ? smoothstep(-0.5, -5.0, tNow) : smoothstep(-4.0, -10.0, tNow)) : 0.0;
    ice = smoothstep(0.3, 0.6, ice + 0.3 * (vnoise3(P / 30000.0) - 0.5));
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(up, V), 0.0), 5.0);
    col = mix(col, vec3(0.55, 0.65, 0.78) * amb, fres * 0.5);
    float spec = pow(max(dot(reflect(-L, up), V), 0.0), 90.0);
    col = mix(col, vec3(0.80, 0.86, 0.90) * (0.75 + 0.3 * max(dot(n, L), 0.0)), ice * 0.95);
    col *= 0.35 * amb + 0.65 * lightCol;
    col += spec * 0.45 * lightCol * (1.0 - ice);
  } else {
    if (u_layerMode == 1) col = categorical(floor(layerAt(f, ang, true) + 0.5));
    else if (u_layerMode == 2) col = viridis((layerAt(f, ang, false) - u_layerMin) / max(1e-6, u_layerMax - u_layerMin));
    else if (u_hasClimate == 1 && u_palette == 0) {
      // Biome-table colours over temperature and aridity (the biome stage's P/PET once it exists, else
      // a proxy from precipitation), varied by 3D noise; the biome stage's cover (sand, marsh, rock,
      // perennial snow) as on flat maps, else rock on steep slopes and snow from temperature.
      float fine = 1.0 - smoothstep(600.0, 2500.0, pxFoot);
      float t = cl.r + 3.0 * (vnoise3(P / 35000.0) - 0.5);
      float ai = max(0.02, cl.g) * exp(0.4 * (vnoise3(P / 28000.0 + 11.0) - 0.5));
      vec2 luv = clamp(vec2((t + 20.0) / 50.0, log(ai * 10.0) / log(10.0) / 2.0), 0.5 / 64.0, 1.0 - 0.5 / 64.0);
      float drySummer = smoothstep(0.45, 0.30, cl.b);
      col = mix(texture(u_lut, vec2(luv.x, 0.5 * luv.y)).rgb, texture(u_lut, vec2(luv.x, 0.5 + 0.5 * luv.y)).rgb, drySummer);
      col *= 0.88 + 0.24 * vnoise3(P / 90000.0 + 3.0);
      col *= mix(1.0, 0.9 + 0.2 * vnoise3(P / 3500.0), fine);
      float slope = length(grad);
      vec3 rockCol = vec3(0.44, 0.42, 0.40) * (0.85 + 0.3 * vnoise3(P / 6000.0));
      float snowBreak = 0.35 * (vnoise3(P / 7000.0) - 0.5) - 0.3 * smoothstep(0.6, 1.2, slope);
      if (u_hasCover == 1) {
        vec4 cv = coverAt(f, ang);
        col = mix(col, vec3(0.86, 0.80, 0.66), smoothstep(0.15, 0.7, cv.b) * 0.9);   // beach / dunes / salt / erg
        col = mix(col, vec3(0.24, 0.32, 0.22), smoothstep(0.15, 0.8, cv.a) * 0.5);   // marsh / bog / mangrove
        col = mix(col, rockCol, max(smoothstep(0.2, 0.75, cv.g), smoothstep(0.35, 0.75, slope)) * 0.85);
        float snow = smoothstep(0.35, 0.95, 0.85 * cv.r + snowBreak);
        // Seasonal snow where it is below freezing now but not at the warm peak (as on flat maps).
        float sSnow = u_realistic == 1 ? max(0.0, smoothstep(1.5, -3.0, tNow) - smoothstep(1.5, -3.0, cl.r + cl.a)) * smoothstep(0.08, 0.3, ai) : 0.0;
        snow = max(snow, smoothstep(0.15, 0.7, sSnow + 0.6 * snowBreak));
        col = mix(col, vec3(0.90, 0.92, 0.96), snow * 0.85);
      } else {
        col = mix(col, rockCol, smoothstep(0.35, 0.75, slope) * 0.85);
        float snowT = u_realistic == 1 ? min(tNow, cl.r + 2.0) : cl.r;
        float snow = smoothstep(0.35, 0.95, smoothstep(-1.0, -7.0, snowT + 4.0 * snowBreak) + snowBreak);
        col = mix(col, vec3(0.90, 0.92, 0.96), snow * 0.85 * smoothstep(0.05, 0.25, ai));
      }
    } else col = hypsometric(h);
    float lambert = max(dot(n, L), 0.0);
    float sky = 0.5 + 0.5 * dot(n, up);
    bool biomeLit = u_layerMode == 0 && u_hasClimate == 1 && u_palette == 0;
    col *= biomeLit ? 0.30 * sky * amb + 1.25 * lambert * lightCol : 0.28 * sky * amb + 0.95 * lambert * lightCol;
  }
  // Aerial perspective through the same atmosphere as the sky and the limb (integrated per vertex).
  col = col * v_trans + v_air;
  col = 1.0 - exp(-col * 1.2);
  o = vec4(pow(col, vec3(1.0 / 1.1)), 1.0);
}`;

export interface GlobeFrame {
  viewProj: Float32Array;
  instances: Float32Array;
  count: number;
  exaggeration: number;
  normalExaggeration: number;
  /** Cartographic sun in (screen right, screen up, local up) coordinates, and the camera axes. */
  sunCarto: readonly [number, number, number];
  camRight: { x: number; y: number; z: number };
  camUp: { x: number; y: number; z: number };
  sunReal: readonly [number, number, number];
  realK: number;
  light: readonly [number, number, number];
  ambient: readonly [number, number, number];
  realistic: boolean;
  season: readonly [number, number];
  time: number;
  atmos: GlobeAtmosFrame;
  /** Close-zoom detail (uniforms and textures), the eye (planet-centred, float64) and 2·tan(fovY/2)/viewH. */
  detail: GlobeDetailUniforms;
  eye: Vec3;
  pxScale: number;
}

/**
 * Climate rasters for globe colouring (any face grid), plus the biome stage's rasters once they exist
 * (on the same grid as the temperature; otherwise the climate proxy colours stay).
 */
export interface GlobeSurface {
  temperature: Layer;
  precip: Layer | null;
  summerRain: Layer | null;
  tempRange: Layer | null;
  /** Biome stage: P / PET, biome ids and perennial snow; optional landform erg mask (0–255). */
  aridity?: Layer | null;
  biome?: Layer | null;
  snow?: Layer | null;
  erg?: Layer | null;
}

const LAYER_MODE: Record<LayerKind, number> = { elevation: 0, categorical: 1, scalar: 2 };

/**
 * The globe's terrain (Sphere phase 3): sphere CDLOD nodes drawn with one instanced call over the same
 * 33×33 grid mesh as the flat terrain. Rasters are 6-layer texture arrays with border padding
 * (globe/cubeTex.ts). Shading follows the flat terrain pass with what spheres have so far: the
 * biome-table colours from climate (or hypsometric tints), ocean depth colour, Lambert plus sky light,
 * draped data layers, and the shared atmosphere for aerial perspective.
 */
export class GlobePass {
  private readonly prog: WebGLProgram;
  private readonly u;
  private readonly vao: WebGLVertexArrayObject;
  private readonly instBuf: WebGLBuffer;
  private readonly indexCount: number;
  private readonly heightTex: WebGLTexture;
  private readonly gradTex: WebGLTexture;
  private readonly climateTex: WebGLTexture;
  private readonly coverTex: WebGLTexture;
  private readonly surfTex: WebGLTexture;
  private readonly wlevelTex: WebGLTexture;
  private readonly wlevelDTex: WebGLTexture;
  private readonly wetDTex: WebGLTexture;
  private readonly wclassTex: WebGLTexture;
  private hasCover = 0;
  private hasWater = 0;
  private readonly layerTex: WebGLTexture;
  private readonly lutTex: WebGLTexture;
  palette: Palette | 'hypsometric' = 'satellite';
  private lutPalette: Palette | null = null;
  private hn = 1;
  private radius = 1;
  private cn = 1;
  private hasClimate = 0;
  private ln = 1;
  private layerMode = 0;
  private layerMin = 0;
  private layerMax = 1;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.prog = compileProgram(gl, 'globe', VS, FS);
    this.u = uniforms(gl, this.prog, [
      'u_viewProj', 'u_radius', 'u_exag', 'u_normalExag', 'u_faceC', 'u_faceE', 'u_faceS', 'u_height', 'u_hn', 'u_grad',
      'u_climate', 'u_cn', 'u_hasClimate', 'u_lut', 'u_palette', 'u_layer', 'u_ln', 'u_layerMode', 'u_layerMin', 'u_layerMax',
      'u_sunCarto', 'u_camRight', 'u_camUp', 'u_sunReal', 'u_realK', 'u_lightCol', 'u_ambient', 'u_realistic', 'u_season', 'u_time',
      'u_surf', 'u_cover', 'u_hasCover', 'u_wlevel', 'u_wclass', 'u_hasWater', 'u_pxScale', 'u_wlevelD', 'u_wetD',
    ] as const);

    const verts = new Float32Array((GRID + 1) * (GRID + 1) * 2);
    for (let y = 0, k = 0; y <= GRID; y++) for (let x = 0; x <= GRID; x++) (verts[k++] = x), (verts[k++] = y);
    const idx = new Uint16Array(GRID * GRID * 6);
    for (let y = 0, k = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const a = y * (GRID + 1) + x;
        const b = a + 1;
        const c = a + GRID + 1;
        const d = c + 1;
        idx.set([a, c, b, b, c, d], k);
        k += 6;
      }
    }
    this.indexCount = idx.length;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, SPHERE_MAX_NODES * SPHERE_INSTANCE_FLOATS * 4, gl.DYNAMIC_DRAW);
    const stride = SPHERE_INSTANCE_FLOATS * 4;
    const attr = (loc: number, size: number, offset: number): void => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(1, 4, 0);
    attr(2, 3, 16);
    attr(3, 3, 28);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    this.heightTex = arrayTexture(gl, 'r32f');
    this.gradTex = arrayTexture(gl, 'rgba16f');
    this.climateTex = arrayTexture(gl, 'rgba16f');
    this.coverTex = arrayTexture(gl, 'rgba8');
    this.surfTex = arrayTexture(gl, 'r32f');
    this.wlevelTex = arrayTexture(gl, 'r32f');
    this.wlevelDTex = arrayTexture(gl, 'r32f');
    this.wetDTex = arrayTexture(gl, 'r32f');
    this.wclassTex = arrayTexture(gl, 'r32f');
    this.layerTex = arrayTexture(gl, 'r32f');
    this.lutTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  }

  /**
   * Elevation (six faces), its CPU-built 3D gradients and the rendered surface of the CPU height field
   * (`hf.padded`: the water lid). `water`: prepared levels and classes (prepareWaterSphere) on the
   * same grid, or null (the sea only). `detailLevel`: the same levels prepared without river cells, which
   * the close-zoom detail uses, and `detailWet` its padded real-water mask (PreparedGlobe.wetPad).
   * Defaults: `water.level`, and 1 everywhere.
   */
  setTerrain(
    layer: Layer, hf: GlobeHeightField, water: { level: Float32Array; cls: Float32Array } | null = null,
    detailLevel: Float32Array | null = null, detailWet: Float32Array | null = null,
  ): void {
    const gl = this.gl;
    const n = layer.w;
    const radiusM = hf.radius;
    this.hn = n;
    this.radius = radiusM;
    uploadArray(gl, this.heightTex, padFaces(layer.data, n), n + 2 * PAD, 'r32f');
    uploadArray(gl, this.surfTex, hf.padded, n + 2 * PAD, 'r32f');
    this.hasWater = water ? 1 : 0;
    if (water) {
      uploadArray(gl, this.wlevelTex, padFaces(water.level, n), n + 2 * PAD, 'r32f');
      uploadArray(gl, this.wlevelDTex, padFaces(detailLevel ?? water.level, n), n + 2 * PAD, 'r32f');
      uploadArray(gl, this.wetDTex, detailWet ?? padFaces(new Float32Array(6 * n * n).fill(1), n), n + 2 * PAD, 'r32f');
      uploadArray(gl, this.wclassTex, padFaces(water.cls, n), n + 2 * PAD, 'r32f');
    }
    // Gradient mips per layer (a texture array's levels must all hold 6 layers).
    let g = sphereGradients(layer.data, n, radiusM);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.gradTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    let size = n;
    for (let l = 0; size >= 1; l++) {
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, l, gl.RGBA16F, size, size, 6, 0, gl.RGBA, gl.FLOAT, g);
      if (size === 1) break;
      g = halveFaces(g, size);
      size >>= 1;
    }
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Climate for realistic colours; null falls back to hypsometric tints. */
  setSurface(s: GlobeSurface | null): void {
    this.hasClimate = s ? 1 : 0;
    if (!s) return;
    const n = s.temperature.w;
    const N = 6 * n * n;
    const fit = (l: Layer | null): Layer | null => (l && l.w === n && l.faces === 6 ? l : null);
    const pr = fit(s.precip);
    const sr = fit(s.summerRain);
    const tr = fit(s.tempRange);
    const ar = fit(s.aridity ?? null);
    const clim = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      const t = s.temperature.data[i];
      // Without the biome stage: aridity P / PET with a Holdridge-style PET (58.93 mm per °C of
      // biotemperature), as the generator's climate model; the floor keeps cold places from the clamp.
      const pet = 58.93 * Math.min(30, Math.max(0, t));
      clim[i * 4] = t;
      clim[i * 4 + 1] = ar ? ar.data[i] : pr ? Math.min(10, pr.data[i] / Math.max(150, pet)) : 1;
      clim[i * 4 + 2] = sr ? sr.data[i] : 0.5;
      clim[i * 4 + 3] = tr ? tr.data[i] : 10;
    }
    this.cn = n;
    uploadArray(this.gl, this.climateTex, padFaces(clim, n, PAD, 4), n + 2 * PAD, 'rgba16f', true);
    const bio = fit(s.biome ?? null);
    const snow = fit(s.snow ?? null);
    this.hasCover = bio && snow && ar ? 1 : 0;
    if (bio && snow && ar) {
      const cover = coverMasksSphere(bio.data, snow.data, fit(s.erg ?? null)?.data ?? null, n);
      uploadArray(this.gl, this.coverTex, cover, n + 2 * PAD, 'rgba8', true);
    }
  }

  /** Drapes a sphere layer over the globe (null = realistic colouring). */
  setDrape(layer: Layer | null): void {
    if (!layer || layer.kind === 'elevation' || layer.faces !== 6) {
      this.layerMode = 0;
      return;
    }
    this.ln = layer.w;
    uploadArray(this.gl, this.layerTex, padFaces(layer.data, layer.w), layer.w + 2 * PAD, 'r32f');
    this.layerMode = LAYER_MODE[layer.kind];
    this.layerMin = layer.min;
    this.layerMax = layer.max;
  }

  /** No data layer is draped (realistic or hypsometric colours): rivers draw over it. */
  get layerModeRealistic(): boolean {
    return this.layerMode === 0;
  }

  /** Realistic colouring is showing (time of day and seasons apply). */
  get realistic(): boolean {
    return this.layerMode === 0 && this.hasClimate === 1 && this.palette !== 'hypsometric';
  }

  private ensureLut(): void {
    const p: Palette = this.palette === 'stylised' ? 'stylised' : 'satellite';
    if (this.lutPalette === p) return;
    this.lutPalette = p;
    const lut = new Uint8Array(LUT_SIZE * LUT_SIZE * 8);
    lut.set(buildBiomeLut(p, false), 0);
    lut.set(buildBiomeLut(p, true), LUT_SIZE * LUT_SIZE * 4);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, LUT_SIZE, LUT_SIZE * 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
  }

  draw(f: GlobeFrame): void {
    const gl = this.gl;
    const u = this.u;
    gl.useProgram(this.prog);
    this.ensureLut();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, f.instances, 0, f.count * SPHERE_INSTANCE_FLOATS);
    gl.uniformMatrix4fv(u.u_viewProj, false, f.viewProj);
    gl.uniform1f(u.u_radius, this.radius);
    gl.uniform1f(u.u_exag, f.exaggeration);
    gl.uniform1f(u.u_normalExag, f.normalExaggeration);
    gl.uniform3fv(u.u_faceC, FACE_C);
    gl.uniform3fv(u.u_faceE, FACE_E);
    gl.uniform3fv(u.u_faceS, FACE_S);
    gl.uniform1i(u.u_hn, this.hn);
    gl.uniform1i(u.u_cn, this.cn);
    gl.uniform1i(u.u_hasClimate, this.hasClimate);
    gl.uniform1i(u.u_palette, this.palette === 'hypsometric' ? 1 : 0);
    gl.uniform1i(u.u_ln, this.ln);
    gl.uniform1i(u.u_layerMode, this.layerMode);
    gl.uniform1f(u.u_layerMin, this.layerMin);
    gl.uniform1f(u.u_layerMax, this.layerMax);
    gl.uniform3f(u.u_sunCarto, f.sunCarto[0], f.sunCarto[1], f.sunCarto[2]);
    gl.uniform3f(u.u_camRight, f.camRight.x, f.camRight.y, f.camRight.z);
    gl.uniform3f(u.u_camUp, f.camUp.x, f.camUp.y, f.camUp.z);
    gl.uniform3f(u.u_sunReal, f.sunReal[0], f.sunReal[1], f.sunReal[2]);
    gl.uniform1f(u.u_realK, f.realK);
    gl.uniform3f(u.u_lightCol, f.light[0], f.light[1], f.light[2]);
    gl.uniform3f(u.u_ambient, f.ambient[0], f.ambient[1], f.ambient[2]);
    gl.uniform1i(u.u_realistic, f.realistic ? 1 : 0);
    gl.uniform2f(u.u_season, f.season[0], f.season[1]);
    gl.uniform1f(u.u_time, f.time);
    gl.uniform1f(u.u_pxScale, f.pxScale);
    const bindArr = (unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null): void => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      gl.uniform1i(loc, unit);
    };
    bindArr(0, this.heightTex, u.u_height);
    bindArr(1, this.gradTex, u.u_grad);
    bindArr(2, this.climateTex, u.u_climate);
    bindArr(3, this.layerTex, u.u_layer);
    bindArr(5, this.surfTex, u.u_surf);
    bindArr(6, this.coverTex, u.u_cover);
    bindArr(7, this.wlevelTex, u.u_wlevel);
    bindArr(12, this.wlevelDTex, u.u_wlevelD);
    bindArr(13, this.wetDTex, u.u_wetD);
    bindArr(8, this.wclassTex, u.u_wclass);
    gl.uniform1i(u.u_hasCover, this.hasCover);
    gl.uniform1i(u.u_hasWater, this.hasWater);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.uniform1i(u.u_lut, 4);
    f.detail.bind(gl, this.prog, 9, f.eye);
    bindGlobeAtmos(gl, this.prog, f.atmos);
    gl.bindVertexArray(this.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0, f.count);
    gl.bindVertexArray(null);
  }
}

/**
 * Surface gradient per cell as a 3D tangent vector in planet axes (RGBA, a unused): central
 * differences along the face's two grid directions over padded heights (so border cells see across
 * the seam), solved against the two chord vectors. 3D vectors are the same quantity on both sides of
 * a seam, which lets the mipmapped texture skip padding. The six faces are congruent, so the chords
 * and their Gram system are computed once in face-local axes (e, s, c) and rotated per face; border
 * cells use the true centres of their neighbours across the seam.
 */
export function sphereGradients(data: ArrayLike<number>, n: number, R: number): Float32Array {
  const m = n + 2 * PAD;
  const pad = padFaces(data, n);
  const out = new Float32Array(6 * n * n * 4);
  const delta = Math.PI / 2 / n;
  const Q = Math.PI / 4;
  // Face-local cell-centre positions for columns / rows −1 … n (the equal-angle grid continues past the edge).
  const tan = Float64Array.from({ length: n + 2 }, (_, i) => Math.tan((i - 0.5) * delta - Q));
  const local = (x: number, y: number, o: Float64Array): void => {
    const X = tan[x + 1], Y = tan[y + 1];
    const k = R / Math.sqrt(1 + X * X + Y * Y);
    o[0] = X * k;
    o[1] = Y * k;
    o[2] = k;
  };
  // Per face position: chords ta, tb (local) and the inverse Gram coefficients.
  const geo = new Float64Array(n * n * 9);
  const pa = new Float64Array(3), pb = new Float64Array(3), pc = new Float64Array(3), pd = new Float64Array(3);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      local(x + 1, y, pa);
      local(x - 1, y, pb);
      local(x, y + 1, pc);
      local(x, y - 1, pd);
      const o = (y * n + x) * 9;
      let aa = 0, bb = 0, ab = 0;
      for (let c = 0; c < 3; c++) {
        const ta = pa[c] - pb[c];
        const tb = pc[c] - pd[c];
        geo[o + c] = ta;
        geo[o + 3 + c] = tb;
        aa += ta * ta;
        bb += tb * tb;
        ab += ta * tb;
      }
      const det = aa * bb - ab * ab;
      geo[o + 6] = bb / det;
      geo[o + 7] = ab / det;
      geo[o + 8] = aa / det;
    }
  }
  const s = (v: number): number => (v > 0 ? v : 0);
  for (let f = 0; f < 6; f++) {
    const k = f * 3;
    const ex = FACE_E[k], ey = FACE_E[k + 1], ez = FACE_E[k + 2];
    const sx = FACE_S[k], sy = FACE_S[k + 1], sz = FACE_S[k + 2];
    const cx = FACE_C[k], cy = FACE_C[k + 1], cz = FACE_C[k + 2];
    for (let y = 0; y < n; y++) {
      const row = f * m * m + (y + PAD) * m + PAD;
      for (let x = 0; x < n; x++) {
        if (x === 0 || y === 0 || x === n - 1 || y === n - 1) {
          borderGradient(data, n, R, f, x, y, out);
          continue;
        }
        const i = row + x;
        const ha = s(pad[i + 1]) - s(pad[i - 1]);
        const hb = s(pad[i + m]) - s(pad[i - m]);
        const g = (y * n + x) * 9;
        // g = α ta + β tb with g·ta = ha, g·tb = hb (Gram system).
        const al = ha * geo[g + 6] - hb * geo[g + 7];
        const be = hb * geo[g + 8] - ha * geo[g + 7];
        const lx = al * geo[g] + be * geo[g + 3];
        const ly = al * geo[g + 1] + be * geo[g + 4];
        const lz = al * geo[g + 2] + be * geo[g + 5];
        const o = ((f * n + y) * n + x) * 4;
        out[o] = lx * ex + ly * sx + lz * cx;
        out[o + 1] = lx * ey + ly * sy + lz * cy;
        out[o + 2] = lx * ez + ly * sz + lz * cz;
      }
    }
  }
  return out;
}

/** Gradient of a face-border cell from its four axial neighbours' true positions (some across a seam). */
function borderGradient(data: ArrayLike<number>, n: number, R: number, f: number, x: number, y: number, out: Float32Array): void {
  const d = new Float64Array(3);
  const at = (dx: number, dy: number): [number, number, number, number] => {
    const nx = x + dx, ny = y + dy;
    const idx = nx < 0 ? acrossCell(n, f, SIDE_W, y, 0)
      : nx >= n ? acrossCell(n, f, SIDE_E, y, 0)
      : ny < 0 ? acrossCell(n, f, SIDE_N, x, 0)
      : ny >= n ? acrossCell(n, f, SIDE_S, x, 0)
      : (f * n + ny) * n + nx;
    const g = Math.floor(idx / (n * n));
    const r = idx - g * n * n;
    const cy = Math.floor(r / n), cx = r - cy * n;
    faceDir(g, ((cx + 0.5) / n - 0.5) * (Math.PI / 2), ((cy + 0.5) / n - 0.5) * (Math.PI / 2), d);
    return [d[0] * R, d[1] * R, d[2] * R, Math.max(0, data[idx])];
  };
  const pa = at(1, 0), pb = at(-1, 0), pc = at(0, 1), pd = at(0, -1);
  const ta = [pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]];
  const tb = [pc[0] - pd[0], pc[1] - pd[1], pc[2] - pd[2]];
  const ha = pa[3] - pb[3];
  const hb = pc[3] - pd[3];
  const aa = ta[0] * ta[0] + ta[1] * ta[1] + ta[2] * ta[2];
  const bb = tb[0] * tb[0] + tb[1] * tb[1] + tb[2] * tb[2];
  const ab = ta[0] * tb[0] + ta[1] * tb[1] + ta[2] * tb[2];
  const det = aa * bb - ab * ab;
  const al = (ha * bb - hb * ab) / det;
  const be = (hb * aa - ha * ab) / det;
  const o = ((f * n + y) * n + x) * 4;
  out[o] = al * ta[0] + be * tb[0];
  out[o + 1] = al * ta[1] + be * tb[1];
  out[o + 2] = al * ta[2] + be * tb[2];
}

/**
 * Cover masks of the flat terrain (snow/ice, bare rock, sand, marsh) on six faces, 3×3 box-blurred
 * across seams (through 1-texel face padding) and padded for upload as RGBA8. Sand includes the
 * landform erg mask (0–255) where given.
 */
export function coverMasksSphere(biome: ArrayLike<number>, snow: ArrayLike<number>, erg: ArrayLike<number> | null, n: number): Uint8Array {
  const N = 6 * n * n;
  const raw = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const id = biome[i];
    raw[i * 4] = Math.max(snow[i], id === BIOME.ICE ? 1 : 0);
    raw[i * 4 + 1] = id === BIOME.ROCK || id === BIOME.NIVAL ? 1 : 0;
    raw[i * 4 + 2] = Math.max(id === BIOME.BEACH || id === BIOME.SALT_FLAT ? 1 : 0, erg ? (0.6 * erg[i]) / 255 : 0);
    raw[i * 4 + 3] = id === BIOME.MARSH || id === BIOME.BOG || id === BIOME.SALT_MARSH || id === BIOME.MANGROVE || id === BIOME.SWAMP || id === BIOME.FEN ? 1 : 0;
  }
  const p1 = padFaces(raw, n, 1, 4);
  const m1 = n + 2;
  const blurred = new Float32Array(N * 4);
  for (let f = 0; f < 6; f++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const o = ((f * n + y) * n + x) * 4;
        for (let c = 0; c < 4; c++) {
          let acc = 0;
          for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) acc += p1[((f * m1 + y + dy) * m1 + x + dx) * 4 + c];
          blurred[o + c] = acc / 9;
        }
      }
    }
  }
  const padded = padFaces(blurred, n, PAD, 4);
  return Uint8Array.from(padded, (v) => Math.round(255 * Math.min(1, Math.max(0, v))));
}

/** 2×2 box-filtered half-resolution copy of six interleaved RGBA faces. */
function halveFaces(src: Float32Array, n: number): Float32Array {
  const h = n >> 1;
  const out = new Float32Array(6 * h * h * 4);
  for (let f = 0; f < 6; f++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < h; x++) {
        for (let c = 0; c < 4; c++) {
          const a = ((f * n + 2 * y) * n + 2 * x) * 4 + c;
          out[((f * h + y) * h + x) * 4 + c] = 0.25 * (src[a] + src[a + 4] + src[a + 4 * n] + src[a + 4 * n + 4]);
        }
      }
    }
  }
  return out;
}
