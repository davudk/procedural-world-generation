import type { Layer, LayerKind } from '../../shared/protocol';
import { compileProgram, uniforms } from '../gl/util';
import { COLORMAPS_GLSL } from '../glsl/colormaps';
import { DETAIL_GLSL, type DetailUniforms } from '../glsl/detail';
import { ATMOS_GLSL, bindAtmos, type AtmosFrame } from '../lighting/atmosphere';
import { waterSurface } from '../heightField';
import { BIOME } from '../../shared/biomes';
import { buildBiomeLut, buildBiomePalette, LUT_SIZE, type Palette } from './biomeLut';
import { GRID, INSTANCE_FLOATS, MAX_NODES } from './cdlod';

const HEIGHT_GLSL = /* glsl */ `
uniform sampler2D u_height;   // R32F, row 0 = north
uniform int u_hn;             // height raster size (cells per side)
uniform float u_size;         // world size (m)
uniform vec3 u_origin;        // camera-relative origin (world m), split hi/lo not needed below 4096 km for M2

uniform sampler2D u_water;    // R32F water level (m), < -9000 = dry; same grid as u_height
uniform int u_hasWater;

float hFetch(ivec2 t) { return texelFetch(u_height, clamp(t, ivec2(0), ivec2(u_hn - 1)), 0).r; }
float wFetch(ivec2 t) {
  if (u_hasWater == 0) return hFetch(t) < 0.0 ? 0.0 : -10000.0;
  return texelFetch(u_water, clamp(t, ivec2(0), ivec2(u_hn - 1)), 0).r;
}
// Rendered surface per texel: the water lid max(terrain, water level).
float sFetch(ivec2 t) {
  float h = hFetch(t), wl = wFetch(t);
  return wl > -9000.0 ? max(h, wl) : max(h, 0.0);
}

// Manual bilinear (R32F is not filterable everywhere; research 04 §1.3). w = world xy (m).
float rawHeight(vec2 w) {
  vec2 p = vec2(w.x, u_size - w.y) / u_size * float(u_hn) - 0.5;
  ivec2 i = ivec2(floor(p));
  vec2 f = p - vec2(i);
  float a = hFetch(i), b = hFetch(i + ivec2(1, 0)), c = hFetch(i + ivec2(0, 1)), d = hFetch(i + ivec2(1, 1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float surfaceHeight(vec2 w) {
  vec2 p = vec2(w.x, u_size - w.y) / u_size * float(u_hn) - 0.5;
  ivec2 i = ivec2(floor(p));
  vec2 f = p - vec2(i);
  float a = sFetch(i), b = sFetch(i + ivec2(1, 0)), c = sFetch(i + ivec2(0, 1)), d = sFetch(i + ivec2(1, 1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Bilinear water level (levels are pre-extended around water bodies, so this is smooth at shores).
float waterLevelAt(vec2 w) {
  vec2 p = vec2(w.x, u_size - w.y) / u_size * float(u_hn) - 0.5;
  ivec2 i = ivec2(floor(p));
  vec2 f = p - vec2(i);
  return mix(mix(wFetch(i), wFetch(i + ivec2(1, 0)), f.x), mix(wFetch(i + ivec2(0, 1)), wFetch(i + ivec2(1, 1)), f.x), f.y);
}`;

const VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
layout(location = 0) in vec2 a_grid;      // 0..GRID
layout(location = 1) in vec4 a_node;      // rel x, rel y, size, level
layout(location = 2) in vec2 a_morph;     // morph start, end (m)
uniform mat4 u_viewProj;
uniform float u_exag;
uniform float u_pxScale;  // metres per pixel per metre of distance: 2·tan(fovY/2)/viewH
${HEIGHT_GLSL}
${DETAIL_GLSL}
out vec3 v_world;     // absolute world xy (z unused: the FS recomputes the height per pixel)
out float v_dist;
void main() {
  float size = a_node.z;
  vec2 rel0 = a_node.xy + a_grid / ${GRID}.0 * size;
  vec2 w0 = rel0 + u_origin.xy;
  float d0 = length(vec3(rel0, surfaceHeight(w0) * u_exag - u_origin.z));
  // Geomorph toward the coarser grid near the end of this level's range.
  float k = clamp((d0 - a_morph.x) / (a_morph.y - a_morph.x), 0.0, 1.0);
  vec2 g = a_grid - fract(a_grid * 0.5) * 2.0 * k;
  vec2 rel = a_node.xy + g / ${GRID}.0 * size;
  vec2 w = rel + u_origin.xy;
  // Geometry can't hold wavelengths under ~2 vertex spacings: the footprint is at least the spacing,
  // and grows with the morph factor so detail octaves fade together with vertex snapping.
  float spacing = size / ${GRID}.0;
  float foot = max(d0 * u_pxScale, spacing * (1.0 + k));
  float z = terrainSurface(w, foot) * u_exag;   // water lid: sea at 0, lakes at their level
  vec3 pos = vec3(rel, z - u_origin.z);
  v_world = vec3(w, 0.0);
  v_dist = length(pos);
  gl_Position = u_viewProj * vec4(pos, 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec3 v_world;
in float v_dist;
uniform vec3 u_sun;          // unit vector toward the sun
uniform float u_normalExag;  // lighting exaggeration (stronger when zoomed out)
uniform float u_cell;        // height raster cell size (m)
uniform float u_haze;        // haze density (1/m)
uniform vec3 u_hazeColor;
uniform float u_time;
uniform sampler2D u_grad;    // RG16F + mipmaps: surface dh/dx, dh/dy (world axes) at texel centres
uniform sampler2D u_wclass;  // R32F water class (0 land, 1 ocean, 2 lake, 3 river, 4 wetland, 5 playa, 6 salt lake)
uniform int u_hasClass;
uniform sampler2D u_masks;   // RGBA8, linear: r wetland, g salt flat (blurred one cell)
uniform sampler2D u_climate; // RGBA16F, linear: mean T (°C), aridity P/PET, summer rain share, canopy
uniform sampler2D u_cover;   // RGBA8, linear: snow/ice, bare rock, sand (beach + salt flat), marsh/bog/mangrove
uniform sampler2D u_lut;     // biome colour LUT over (T, aridity) in rows 0–63, its dry-summer variant in 64–127
uniform sampler2D u_biomePal; // 32×1 biome colours (biome map mode)
uniform int u_hasSurface;
uniform sampler2D u_sunVis;  // horizon pass: r = sun visibility
uniform sampler2D u_ao;      // horizon pass: r/g = ambient occlusion in g
uniform int u_hasLight;
uniform sampler2D u_reef;    // RGBA8 linear landform masks: r reef, g erg (sand sea), b crater ejecta, a cliff
uniform int u_hasReef;
uniform int u_palette;       // 0 biome LUT (satellite / stylised), 1 hypsometric
uniform sampler2D u_layer;   // optional draped layer
uniform ivec2 u_layerSize;
uniform int u_layerMode;     // 0 realistic, 1 categorical, 2 scalar, 3 biome palette
uniform float u_layerMin, u_layerMax;
uniform float u_exag;
uniform int u_realistic;     // 1: season, vegetation, clouds and fog apply (realistic colouring only)
uniform vec2 u_season;       // seasonal temperature cycle (cos, sin) of the phase; (1, 0) at the warm peak (default)
${HEIGHT_GLSL}
${DETAIL_GLSL}
${COLORMAPS_GLSL}
${ATMOS_GLSL}
out vec4 o;

// Mipmapped, hardware-filtered gradient: smooth normals, and detail below a pixel averages out
// instead of aliasing into blocky shading when 1 km cells are only a few pixels wide.
vec2 gradAt(vec2 w) {
  vec2 uv = vec2(w.x, u_size - w.y) / u_size;
  float texelsPerPx = length(fwidth(w)) / u_cell;
  return textureLod(u_grad, uv, max(0.0, log2(max(texelsPerPx, 1e-6)) - 0.5)).rg;
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + 1.0), u.x), u.y);
}
float fbm3(vec2 p) { return 0.5 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 7.1) + 0.2 * vnoise(p * 4.1 - 3.3); }

// Tree crowns on a jittered grid of spacing S (m), research 04 §6: a Worley-style 3×3 search for the
// nearest crown relative to its radius (jitter ±0.4 hides the lattice). Coverage, the sunlit side and
// the ground shadow all come from that one crown, so each cell costs a hash and a dot product.
// Returns x crown coverage, y sunlit side of the crown, z crown shadow on the ground.
vec3 crownLayer(vec2 w, float S, float dens, vec2 sunDir, float shOff, float rMin, float seed) {
  vec2 g = w / S;
  vec2 b = floor(g) - 1.0;
  float best = 1e9;
  vec2 bd = vec2(9.0);
  float br = 1.0;
  for (int k = 0; k < 9; k++) {
    vec2 cell = b + vec2(float(k % 3), float(k / 3));
    float hh = hash12(cell + seed);
    if (hh >= dens) continue;
    // Jitter and size come from the hash's fractional digits (one hash per cell).
    vec2 d = g - cell - 0.5 - 0.8 * (fract(hh * vec2(97.13, 61.71) + 0.31) - 0.5);
    float r = rMin + 0.12 * fract(hh * 37.1);
    float q = dot(d, d) / (r * r);
    if (q < best) { best = q; bd = d; br = r; }
  }
  if (best > 4.0) return vec3(0.0);
  float cov = 1.0 - smoothstep(0.6, 1.0, sqrt(best));
  float lit = cov * clamp(0.5 + 0.7 * dot(bd, sunDir) / br, 0.0, 1.0);
  float sh = 1.0 - smoothstep(0.5 * br, br, length(bd + sunDir * shOff));
  return vec3(cov, lit, sh);
}

// Biome colour from climate (research 03 §3.4, §5.3): LUT over jittered (T, aridity), dry-summer
// blend, colour variation at three scales, canopy, then overrides (sand, marsh, rock, snow).
vec3 landColor(vec2 w, float h, vec3 n, float pxFoot, vec2 grad, vec4 c2) {
  vec2 uv = vec2(w.x, u_size - w.y) / u_size;
  vec4 cl = texture(u_climate, uv);
  vec4 cv = texture(u_cover, uv);
  // Footprint fade so sub-pixel noise doesn't shimmer.
  float fine = 1.0 - smoothstep(600.0, 2500.0, pxFoot);
  // Season (M9): T(s) = annual mean + half-range·cos(phase), carried by the lapse rate from the macro
  // grid to the detailed surface so snowlines follow ridges. Every term is zero at the warm peak.
  bool seasonal = u_realistic == 1 && u_season.x < 0.9999;
  float tAmp = c2.r * 30.0;
  float tLapse = seasonal ? -0.0065 * (h - rawHeight(w)) : 0.0;
  float tNow = cl.r + tAmp * u_season.x + tLapse;
  float tPeak = cl.r + tAmp + tLapse;
  float winter = max(0.0, -u_season.x);
  float t = cl.r + 3.0 * (fbm3(w / 35000.0) - 0.5);
  float ai = max(0.02, cl.g) * exp(0.4 * (fbm3(w / 28000.0 + 11.0) - 0.5));
  vec2 luv = clamp(vec2((t + 20.0) / 50.0, log(ai * 10.0) / log(10.0) / 2.0), 0.5 / 64.0, 1.0 - 0.5 / 64.0);
  // Dry-summer (Mediterranean) colours green up in the wet winter.
  float drySummer = smoothstep(0.45, 0.30, cl.b) * (1.0 - 0.7 * winter);
  vec3 c = mix(texture(u_lut, vec2(luv.x, 0.5 * luv.y)).rgb, texture(u_lut, vec2(luv.x, 0.5 + 0.5 * luv.y)).rgb, drySummer);
  c *= 0.88 + 0.24 * fbm3(w / 90000.0 + 3.0);                    // geology scale
  c *= mix(1.0, 0.9 + 0.2 * vnoise(w / 3500.0), fine);           // field / patch mosaic
  c *= 1.0 - 0.1 * cl.a;                                         // dense canopy reads darker
  float forest = smoothstep(0.2, 0.7, cl.a);
  float sSnow = 0.0;
  float bare = 0.0;
  if (seasonal) {
    // Deciduous trees: autumn colours while cooling through ~14 → 5 °C, bare below; leaves return later in spring.
    float decid = c2.b * forest;
    float leafNow = smoothstep(4.0, 9.0, tNow - 2.0 * smoothstep(0.0, 0.25, -u_season.y));
    float leafPeak = smoothstep(4.0, 9.0, tPeak);
    bare = decid * max(0.0, leafPeak - leafNow);
    float autumn = decid * leafNow * smoothstep(0.0, 0.25, u_season.y) * (1.0 - smoothstep(8.0, 14.0, tNow));
    vec3 autumnC = mix(vec3(0.46, 0.25, 0.10), vec3(0.50, 0.41, 0.15), vnoise(w / 650.0)) * (0.8 + 0.5 * dot(c, vec3(0.3, 0.5, 0.2)) / 0.3);
    c = mix(c, autumnC, autumn * 0.65);
    c = mix(c, vec3(0.38, 0.34, 0.29) * (0.9 + 0.2 * vnoise(w / 2000.0)), bare * 0.7);
    // Grass browns in its dry season (summer-rain climates) and goes dormant in frost.
    float grassy = smoothstep(0.1, 0.3, ai) * (1.0 - smoothstep(1.2, 2.5, ai)) * (1.0 - 0.6 * forest);
    float dormant = max(0.0, smoothstep(5.0, -1.0, tNow) - smoothstep(5.0, -1.0, tPeak));
    float straw = clamp(max(0.6 * dormant, smoothstep(0.55, 0.8, cl.b) * winter), 0.0, 1.0) * grassy;
    c = mix(c, c * vec3(1.3, 1.08, 0.68) + vec3(0.07, 0.05, 0.0), straw * 0.75);
    // Seasonal snow where the place is below freezing now but not at the warm peak; needs some precipitation.
    sSnow = max(0.0, smoothstep(1.5, -3.0, tNow) - smoothstep(1.5, -3.0, tPeak)) * smoothstep(0.08, 0.3, ai);
  }
  if (u_hasReef == 1) {
    vec4 lm = texture(u_reef, uv);
    // Sand seas: warmer, redder sand with dune ridges (≈2 km wavelength) until the detail map takes over.
    float erg = smoothstep(0.05, 0.9, lm.g + 0.25 * (fbm3(w / 14000.0 + 5.0) - 0.5));
    float dunes = 0.5 + 0.5 * sin(dot(w, vec2(0.94, 0.34)) / 320.0 + 4.0 * fbm3(w / 9000.0));
    float duneFade = 1.0 - smoothstep(250.0, 700.0, pxFoot);
    c = mix(c, vec3(0.82, 0.64, 0.42) * (0.92 + 0.12 * dunes * duneFade), erg * 0.55);
    c = mix(c, c * 1.25 + 0.05, smoothstep(0.2, 0.9, lm.b) * 0.5);   // bright crater ejecta
  }
  c = mix(c, vec3(0.86, 0.80, 0.66), smoothstep(0.15, 0.7, cv.b) * 0.9);   // beach / dunes / salt
  c = mix(c, vec3(0.24, 0.32, 0.22), smoothstep(0.15, 0.8, cv.a) * 0.5);   // marsh / bog / mangrove
  float slope = length(grad);
  float rock = max(smoothstep(0.2, 0.75, cv.g), smoothstep(0.35, 0.75, slope));
  vec3 rockCol = vec3(0.44, 0.42, 0.40) * (0.85 + 0.3 * fbm3(w / 6000.0));
  c = mix(c, rockCol, rock * 0.85);
  // Snow lingers on poleward (north-facing) and gentle slopes; elevation noise breaks the snowline.
  float snowBreak = 0.15 * n.y + 0.35 * (fbm3(w / 7000.0) - 0.5) + 0.15 * (vnoise(w / 1800.0) - 0.5) * fine
    - 0.3 * smoothstep(0.6, 1.2, slope);
  float snow = smoothstep(0.35, 0.95, 0.85 * cv.r + snowBreak);
  vec3 snowCol = vec3(0.90, 0.92, 0.96);
  c = mix(c, snowCol, snow * 0.85);
  if (u_realistic == 0) return c;
  // Seasonal snow lies on open ground; the canopy hides most of it (crowns are drawn over it below).
  float ground = sSnow > 0.0 ? smoothstep(0.15, 0.7, sSnow + 0.6 * snowBreak) * (1.0 - rock * 0.6) : 0.0;
  vec3 gapC = mix(c, snowCol, ground * 0.85);
  c = mix(c, snowCol, ground * 0.85 * (1.0 - 0.6 * forest * (1.0 - 0.5 * bare)));

  // Vegetation (M9, research 04 §6): stand clumps (~40 m) below ~25 m/px and tree crowns (~13 m)
  // below ~7 m/px, each faded by pixel footprint to the flat canopy colour (no shimmer).
  float dens = smoothstep(0.12, 0.8, cl.a) * (1.0 - rock) * (1.0 - snow);
  float fadeClump = 1.0 - smoothstep(12.0, 26.0, pxFoot);
  if (dens < 0.02 || fadeClump <= 0.0) return c;
  // Conifers by temperature and biome: bluer, smaller crowns with crisper shadows.
  float conif = clamp(max(c2.a, 1.0 - smoothstep(0.0, 7.0, cl.r)) * (1.0 - c2.b), 0.0, 1.0);
  vec3 tint = mix(vec3(0.98, 1.03, 0.90), vec3(0.86, 1.0, 1.08), conif);   // hue only, ~unit luminance
  float sl = length(u_sun.xy);
  vec2 sd = sl > 1e-3 ? u_sun.xy / sl : vec2(0.0, 1.0);
  float shOff = clamp(0.1 * sl / max(u_sun.z, 0.05), 0.04, 0.25);
  // Crowns are lit on the sun side; gaps read darker in a closed forest and as open ground in
  // woodland. Each layer is divided by its expected mean (Poisson coverage) so the fade to the flat
  // canopy colour keeps the same tone at every zoom.
  float gapK = mix(1.05, mix(0.74, 0.9, conif), dens);
  float D1 = 0.2 + 0.65 * dens;
  vec3 k1 = crownLayer(w, 40.0, D1, sd, shOff, 0.42, 3.7);
  float cm1 = 1.0 - exp(-0.55 * D1);
  float e1 = cm1 * mix(1.03, 0.9, conif) + (1.0 - cm1) * gapK * (1.0 - 0.12 * cm1);
  vec3 crown1 = mix(c * tint, vec3(0.36, 0.33, 0.28), bare * 0.5) * mix(0.85 + 0.35 * k1.y, 0.78 + 0.25 * k1.y, conif);
  vec3 mid = mix(gapC * gapK * (1.0 - 0.35 * k1.z), crown1, k1.x) / e1;
  vec3 col = mix(c, mid, fadeClump * 0.8);
  float fadeCrown = 1.0 - smoothstep(3.5, 7.0, pxFoot);
  if (fadeCrown > 0.0) {
    float D2 = min(0.95, dens * mix(0.55, 1.15, k1.x));
    float r2 = mix(0.58, 0.42, conif) + 0.06;
    vec3 k2 = crownLayer(w, 13.0, D2, sd, shOff, r2 - 0.06, 11.9);
    float cm2 = 1.0 - exp(-3.14 * 0.72 * r2 * r2 * dens * 0.85);
    float e2 = cm2 * mix(0.98, 0.8, conif) + (1.0 - cm2) * gapK * (1.0 - 0.15 * cm2);
    vec3 crown2 = mix(c * tint, vec3(0.36, 0.33, 0.28), bare * 0.6) * mix(0.72 + 0.52 * k2.y, 0.62 + 0.36 * k2.y, conif);
    vec3 near = mix(gapC * gapK * (1.0 - 0.45 * k2.z), crown2, k2.x) / e2;
    col = mix(col, near, fadeCrown * 0.85);
  }
  return col;
}

float layerFetch(ivec2 t) { return texelFetch(u_layer, clamp(t, ivec2(0), u_layerSize - 1), 0).r; }
float layerAt(vec2 w, bool nearest) {
  vec2 p = vec2(w.x, u_size - w.y) / u_size * vec2(u_layerSize);
  if (nearest) return layerFetch(ivec2(floor(p)));
  p -= 0.5;
  ivec2 i = ivec2(floor(p));
  vec2 f = p - vec2(i);
  return mix(mix(layerFetch(i), layerFetch(i + ivec2(1, 0)), f.x), mix(layerFetch(i + ivec2(0, 1)), layerFetch(i + ivec2(1, 1)), f.x), f.y);
}

void main() {
  vec2 w = v_world.xy;
  // Per-pixel height: the vertex-interpolated value shows coarse LOD triangles in water colour.
  float pxFoot0 = length(fwidth(w));
  vec3 ds = detailSample(w, pxFoot0);
  float h = ds.x;
  vec2 wp = vec2(w.x, u_size - w.y) / u_size * float(u_hn);
  float cls = u_hasClass == 1 ? texelFetch(u_wclass, clamp(ivec2(floor(wp)), ivec2(0), ivec2(u_hn - 1)), 0).r : (h < 0.0 ? 1.0 : 0.0);
  float wl = waterLevelAt(w);
  bool lake = cls > 1.5 && cls < 2.5 || cls > 5.5;
  bool water = u_hasWater == 1 ? wl > h && (lake || cls > 0.5 && cls < 1.5) : h < 0.0;
  // Mipmapped macro gradient far away, detail gradient (incl. fine octaves) close up.
  vec2 gr = mix(gradAt(w), ds.yz, detailWeight(pxFoot0));
  vec3 n = normalize(vec3(-gr * u_normalExag, 1.0));

  vec3 col;
  vec2 luv = vec2(w.x, u_size - w.y) / u_size;
  float sunVis = u_hasLight == 1 ? texture(u_sunVis, luv).r : 1.0;
  vec2 aoFog = u_hasLight == 1 ? texture(u_ao, luv).gb : vec2(1.0, 0.0);
  float ao = aoFog.x;
  vec4 c2 = texture(u_clim2, luv);
  // Cloud shadows dim the direct light (realistic view only).
  float cs = u_realistic == 1 ? cloudShadow(w, h * u_exag, pxFoot0) : 1.0;
  if (water && u_layerMode == 0) {
    // Water: depth colour, animated wave normals faded by footprint, Fresnel sky, sun glint, shore foam.
    float depth = lake ? max(0.0, wl - h) : -h;
    float pxFoot = length(fwidth(w));
    vec3 shallow = vec3(0.24, 0.56, 0.62), deep = vec3(0.03, 0.10, 0.22);
    if (lake) { shallow = vec3(0.22, 0.48, 0.52); deep = vec3(0.05, 0.16, 0.24); }
    if (cls > 5.5) { shallow = vec3(0.55, 0.78, 0.76); deep = vec3(0.30, 0.58, 0.62); }
    col = mix(shallow, deep, pow(clamp(depth / (lake ? 400.0 : 4000.0), 0.0, 1.0), 0.35));
    col = mix(col, vec3(0.42, 0.68, 0.70), (1.0 - smoothstep(0.0, 60.0, depth)) * 0.6);
    if (u_hasReef == 1 && !lake) {
      // Reefs: turquoise shallows with a pale crest where the reef nearly reaches the surface.
      float reef = texture(u_reef, luv).r;
      col = mix(col, vec3(0.38, 0.80, 0.78), smoothstep(0.1, 0.6, reef) * (1.0 - smoothstep(10.0, 60.0, depth)) * 0.85);
      col = mix(col, vec3(0.80, 0.88, 0.82), smoothstep(0.55, 0.95, reef) * (1.0 - smoothstep(0.0, 8.0, depth)) * 0.6);
    }
    // Lake and sea ice in cold seasons (and in places that never thaw), broken into floes at the edge.
    float ice = 0.0;
    if (u_realistic == 1) {
      float tw = texture(u_climate, luv).r + c2.r * 30.0 * u_season.x;
      ice = lake ? smoothstep(-0.5, -5.0, tw) : smoothstep(-4.0, -10.0, tw);
      if (ice > 0.0) {
        float floes = vnoise(w / 2200.0) * 0.6 + 0.4 * mix(0.5, vnoise(w / 380.0), 1.0 - smoothstep(60.0, 120.0, pxFoot));
        ice = smoothstep(0.35, 0.55, ice + 0.4 * (floes - 0.5)) * min(1.0, ice * 3.0);
      }
    }
    // Waves: three scrolling noise layers; each fades out once its wavelength is under ~4 px.
    vec2 g = vec2(0.0);
    float amp = 0.06;
    float wl0 = 900.0;
    for (int k = 0; k < 3; k++) {
      float fade = 1.0 - smoothstep(wl0 / 8.0, wl0 / 4.0, pxFoot);
      vec2 dir = vec2(cos(float(k) * 2.1 + 0.4), sin(float(k) * 2.1 + 0.4));
      vec2 q = w / wl0 + dir * u_time * (0.05 + 0.03 * float(k));
      float e = 0.07;
      float c0 = vnoise(q);
      g += fade * amp * vec2(vnoise(q + vec2(e, 0.0)) - c0, vnoise(q + vec2(0.0, e)) - c0) / e;
      amp *= 0.6;
      wl0 *= 0.33;
    }
    vec3 nw = normalize(vec3(-g, 1.0));
    // View vector: positions are camera-relative, so the eye sits at u_origin.
    vec3 V = normalize(vec3(u_origin.xy - w, u_origin.z));
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(nw, V), 0.0), 5.0);
    col = mix(col, u_hazeColor * 0.9, fres * 0.6);
    float spec = pow(max(dot(reflect(-u_sun, nw), V), 0.0), 120.0);
    col += spec * 0.5 * sunVis * cs * (1.0 - ice);
    // Foam: a bright line at the shore at any zoom; moving surf bands when close.
    // Shore line ~1.5 px wide at any zoom: depth / |d(depth)/dpx| is the distance to the shore in pixels.
    float foam = 1.0 - smoothstep(0.5, 2.0, depth / max(fwidth(depth), 1e-3));
    float bands = smoothstep(0.55, 0.9, sin(depth * 0.9 - u_time * 1.6 + 6.0 * vnoise(w / 120.0)));
    foam = max(foam * 0.6, bands * (1.0 - smoothstep(0.0, 6.0, depth)) * (1.0 - smoothstep(4.0, 20.0, pxFoot)));
    col = mix(col, vec3(0.86, 0.90, 0.90), foam);
    if (ice > 0.0) {
      vec3 iceC = vec3(0.80, 0.86, 0.90) * (0.92 + 0.12 * vnoise(w / 900.0)) * (0.75 + 0.3 * max(dot(n, u_sun), 0.0));
      col = mix(col, iceC, ice * 0.95);
    }
    col *= mix(0.85, 1.0, sunVis * cs) * (0.35 * u_ambient + 0.65 * u_lightCol);
  } else {
    if (u_layerMode == 1) col = categorical(floor(layerAt(w, true) + 0.5));
    else if (u_layerMode == 2) col = viridis((layerAt(w, false) - u_layerMin) / max(1e-6, u_layerMax - u_layerMin));
    else if (u_layerMode == 3) col = pow(texelFetch(u_biomePal, ivec2(int(layerAt(w, true) + 0.5), 0), 0).rgb, vec3(1.1));
    else if (u_hasSurface == 1 && u_palette == 0) col = landColor(w, h, n, pxFoot0, gr, c2);
    else col = hypsometric(h);
    if (u_layerMode == 0 && u_hasClass == 1) {
      vec2 m = texture(u_masks, vec2(w.x, u_size - w.y) / u_size).rg;
      col = mix(col, vec3(0.90, 0.88, 0.82), smoothstep(0.2, 0.7, m.g) * 0.85);   // salt flat
      col = mix(col, vec3(0.30, 0.40, 0.28), smoothstep(0.15, 0.8, m.r) * 0.32);  // wetland
    }
    float lambert = max(dot(n, u_sun), 0.0);
    float sky = 0.5 + 0.5 * n.z;
    // Biome colours are muted satellite tones: give them more light than the bright hypsometric tints.
    bool biomeLit = u_layerMode == 0 && u_hasSurface == 1 && u_palette == 0;
    lambert *= sunVis * cs;
    sky *= mix(0.55, 1.0, ao) * mix(0.9, 1.0, cs);
    col *= biomeLit ? 0.30 * sky * u_ambient + 1.25 * lambert * u_lightCol : 0.28 * sky * u_ambient + 0.95 * lambert * u_lightCol;
  }
  // Valley fog (M9): pools where the horizon pass found low ground with relief around, in humid air.
  if (u_realistic == 1) col = mix(col, fogColor(), valleyFog(w, aoFog.y, c2.g, pxFoot0));
  col = mix(col, u_hazeColor, 1.0 - exp(-v_dist * u_haze));
  o = vec4(pow(col, vec3(1.0 / 1.1)), 1.0);
}`;

const LAYER_MODE: Record<LayerKind, number> = { elevation: 0, categorical: 1, scalar: 2 };

export interface TerrainFrame {
  /** 2·tan(fovY/2)/viewH, for footprint-based detail fading in the VS. */
  pxScale: number;
  /** Detail-map uniforms (bound on units 13+), or null. */
  detail: DetailUniforms | null;
  /** Horizon-pass textures (sun visibility in r, AO in g), or null before the first pass. */
  lighting: { sun: WebGLTexture; ao: WebGLTexture } | null;
  viewProj: Float32Array;
  origin: { x: number; y: number; z: number };
  instances: Float32Array;
  count: number;
  exaggeration: number;
  normalExaggeration: number;
  sun: readonly [number, number, number];
  haze: number;
  hazeColor: readonly [number, number, number];
  time: number;
  /** Seasonal temperature phase (cos, sin); (1, 0) = the warm peak, the default look. */
  season: readonly [number, number];
  /** Clouds, fog and light colours (M9). */
  atmos: Omit<AtmosFrame, 'clim2'>;
}

/** Draws every selected CDLOD node with one instanced call over a shared grid mesh. */
export class TerrainPass {
  private readonly prog: WebGLProgram;
  private readonly u;
  private readonly vao: WebGLVertexArrayObject;
  private readonly instBuf: WebGLBuffer;
  private readonly indexCount: number;
  private readonly heightTex: WebGLTexture;
  private readonly layerTex: WebGLTexture;
  private readonly gradTex: WebGLTexture;
  private readonly waterTex: WebGLTexture;
  private readonly classTex: WebGLTexture;
  private readonly maskTex: WebGLTexture;
  private readonly climateTex: WebGLTexture;
  private readonly coverTex: WebGLTexture;
  private readonly lutTex: WebGLTexture;
  /** RGBA8 on the climate grid: r seasonal half-range, g cloudiness, b deciduous share, a conifer share. */
  readonly climate2: WebGLTexture;
  private readonly paletteTex: WebGLTexture;
  private readonly reefTex: WebGLTexture;
  private hasReef = 0;
  private hasSurface = 0;
  /** 'hypsometric' ignores biomes and colours by elevation only. */
  palette: Palette | 'hypsometric' = 'satellite';
  private lutPalette: Palette | null = null;
  private hasWater = 0;
  private hasClass = 0;
  private hn = 1;
  private size = 1;
  private layerSize: [number, number] = [1, 1];
  private layerMode = 0;
  private layerMin = 0;
  private layerMax = 1;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.prog = compileProgram(gl, 'terrain', VS, FS);
    this.u = uniforms(gl, this.prog, [
      'u_viewProj', 'u_exag', 'u_pxScale', 'u_height', 'u_hn', 'u_size', 'u_origin', 'u_sun', 'u_normalExag', 'u_cell', 'u_haze', 'u_hazeColor',
      'u_time', 'u_grad', 'u_water', 'u_hasWater', 'u_wclass', 'u_hasClass', 'u_masks', 'u_climate', 'u_cover', 'u_lut', 'u_realistic', 'u_season',
      'u_biomePal', 'u_hasSurface', 'u_palette', 'u_sunVis', 'u_ao', 'u_hasLight', 'u_reef', 'u_hasReef', 'u_layer', 'u_layerSize', 'u_layerMode', 'u_layerMin', 'u_layerMax',
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
    gl.bufferData(gl.ARRAY_BUFFER, MAX_NODES * INSTANCE_FLOATS * 4, gl.DYNAMIC_DRAW);
    const stride = INSTANCE_FLOATS * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    this.heightTex = floatTexture(gl);
    this.layerTex = floatTexture(gl);
    this.gradTex = floatTexture(gl);
    this.waterTex = floatTexture(gl);
    this.classTex = floatTexture(gl);
    this.maskTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.climateTex = linearTexture(gl);
    this.coverTex = linearTexture(gl);
    this.lutTex = linearTexture(gl);
    this.climate2 = linearTexture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 128, 0, 0]));
    this.paletteTex = linearTexture(gl);
    this.reefTex = linearTexture(gl);
  }

  /** Landform masks (0–255 each, same grid) from the landforms stage; any may be missing. */
  setLandformMasks(m: { reef: Layer | null; erg: Layer | null; crater: Layer | null; cliff: Layer | null; n: number } | null): void {
    this.hasReef = m ? 1 : 0;
    if (!m) return;
    const n = m.n;
    const out = new Uint8Array(n * n * 4);
    const put = (l: Layer | null, ch: number): void => {
      if (!l || l.w !== n) return;
      for (let i = 0; i < n * n; i++) out[i * 4 + ch] = l.data[i];
    };
    put(m.reef, 0);
    put(m.erg, 1);
    put(m.crater, 2);
    put(m.cliff, 3);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.reefTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, out);
  }

  /**
   * Climate and biome rasters for realistic colouring. Rasters may be on any grid; null clears them
   * (colours fall back to hypsometric).
   */
  setSurface(s: SurfaceLayers | null): void {
    const gl = this.gl;
    this.hasSurface = s ? 1 : 0;
    if (!s) return;
    const n = s.temperature.w;
    const N = n * n;
    const clim = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      clim[i * 4] = s.temperature.data[i];
      clim[i * 4 + 1] = s.aridity.data[i];
      clim[i * 4 + 2] = s.summerRain ? s.summerRain.data[i] : 0.5;
      clim[i * 4 + 3] = s.canopy.data[i];
    }
    gl.bindTexture(gl.TEXTURE_2D, this.climateTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, n, n, 0, gl.RGBA, gl.FLOAT, clim);
    gl.bindTexture(gl.TEXTURE_2D, this.coverTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, coverMasks(s.biome, s.snow, n));
    gl.bindTexture(gl.TEXTURE_2D, this.climate2);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, climate2(s, n));
  }

  /** Realistic colouring is showing: the only view where season, vegetation, clouds and fog apply. */
  get realistic(): boolean {
    return this.layerMode === 0 && this.hasSurface === 1 && this.palette !== 'hypsometric';
  }

  /** Terrain elevation plus optional prepared water rasters (see prepareWater) on the same grid. */
  setTerrain(layer: Layer, water: { level: Float32Array; cls: Float32Array } | null): void {
    upload(this.gl, this.heightTex, layer);
    this.hn = layer.w;
    this.size = layer.worldKm * 1000;
    if (water) {
      uploadData(this.gl, this.waterTex, water.level, layer.w);
      uploadData(this.gl, this.classTex, water.cls, layer.w);
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.maskTex);
      this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA8, layer.w, layer.w, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, surfaceMasks(water.cls, layer.w));
    }
    this.hasWater = water ? 1 : 0;
    this.hasClass = water ? 1 : 0;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.gradTex);
    // Mips are built on the CPU: generateMipmap needs a colour-renderable format, and RG16F is only
    // renderable with EXT_color_buffer_float.
    let level = gradients(waterSurface(layer, water?.level ?? null), layer);
    let size = layer.w;
    for (let l = 0; size >= 1; l++) {
      gl.texImage2D(gl.TEXTURE_2D, l, gl.RG16F, size, size, 0, gl.RG, gl.FLOAT, level);
      if (size === 1) break;
      level = halveRG(level, size);
      size >>= 1;
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  /** Drapes a layer's colours over the terrain (null = realistic colouring). */
  setDrape(layer: Layer | null): void {
    if (!layer || layer.kind === 'elevation') {
      this.layerMode = 0;
      return;
    }
    upload(this.gl, this.layerTex, layer);
    this.layerSize = [layer.w, layer.h];
    this.layerMode = layer.id === 'biome' ? 3 : LAYER_MODE[layer.kind];
    this.layerMin = layer.min;
    this.layerMax = layer.max;
  }

  /** (Re)builds the colour LUTs when the palette changes. */
  private ensureLut(): void {
    const p: Palette = this.palette === 'stylised' ? 'stylised' : 'satellite';
    if (this.lutPalette === p) return;
    this.lutPalette = p;
    const gl = this.gl;
    // Both LUTs share one texture (normal rows 0–63, dry-summer rows 64–127) to save a texture unit.
    const lut = new Uint8Array(LUT_SIZE * LUT_SIZE * 8);
    lut.set(buildBiomeLut(p, false), 0);
    lut.set(buildBiomeLut(p, true), LUT_SIZE * LUT_SIZE * 4);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, LUT_SIZE, LUT_SIZE * 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 32, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildBiomePalette(p));
  }

  draw(f: TerrainFrame): void {
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, f.instances, 0, f.count * INSTANCE_FLOATS);
    gl.uniformMatrix4fv(this.u.u_viewProj, false, f.viewProj);
    gl.uniform1f(this.u.u_exag, f.exaggeration);   // shared by the VS and FS
    gl.uniform1f(this.u.u_pxScale, f.pxScale);
    gl.uniform3f(this.u.u_origin, f.origin.x, f.origin.y, f.origin.z);
    gl.uniform1i(this.u.u_hn, this.hn);
    gl.uniform1f(this.u.u_size, this.size);
    gl.uniform1f(this.u.u_cell, this.size / this.hn);
    gl.uniform3f(this.u.u_sun, f.sun[0], f.sun[1], f.sun[2]);
    gl.uniform1f(this.u.u_normalExag, f.normalExaggeration);
    gl.uniform1f(this.u.u_haze, f.haze);
    gl.uniform3f(this.u.u_hazeColor, f.hazeColor[0], f.hazeColor[1], f.hazeColor[2]);
    gl.uniform1f(this.u.u_time, f.time);
    gl.uniform1i(this.u.u_layerMode, this.layerMode);
    gl.uniform2i(this.u.u_layerSize, this.layerSize[0], this.layerSize[1]);
    gl.uniform1f(this.u.u_layerMin, this.layerMin);
    gl.uniform1f(this.u.u_layerMax, this.layerMax);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.uniform1i(this.u.u_height, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTex);
    gl.uniform1i(this.u.u_layer, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.gradTex);
    gl.uniform1i(this.u.u_grad, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.waterTex);
    gl.uniform1i(this.u.u_water, 3);
    gl.uniform1i(this.u.u_hasWater, this.hasWater);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.classTex);
    gl.uniform1i(this.u.u_wclass, 4);
    gl.uniform1i(this.u.u_hasClass, this.hasClass);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.uniform1i(this.u.u_masks, 5);
    this.ensureLut();
    const bind = (unit: number, tex: WebGLTexture, loc: WebGLUniformLocation | null): void => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc, unit);
    };
    bind(6, this.climateTex, this.u.u_climate);
    bind(7, this.coverTex, this.u.u_cover);
    bind(8, this.lutTex, this.u.u_lut);
    const realistic = this.realistic;
    gl.uniform1i(this.u.u_realistic, realistic ? 1 : 0);
    gl.uniform2f(this.u.u_season, realistic ? f.season[0] : 1, realistic ? f.season[1] : 0);
    bindAtmos(gl, this.prog, { ...f.atmos, clim2: this.climate2 }, 9);
    bind(10, this.paletteTex, this.u.u_biomePal);
    bind(15, this.reefTex, this.u.u_reef);
    gl.uniform1i(this.u.u_hasReef, this.hasReef);
    gl.uniform1i(this.u.u_hasSurface, this.hasSurface);
    gl.uniform1i(this.u.u_palette, this.palette === 'hypsometric' ? 1 : 0);
    gl.uniform1i(this.u.u_hasLight, f.lighting ? 1 : 0);
    if (f.lighting) {
      bind(11, f.lighting.sun, this.u.u_sunVis);
      bind(12, f.lighting.ao, this.u.u_ao);
    }
    if (f.detail) f.detail.bind(gl, this.prog, 13);
    gl.bindVertexArray(this.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0, f.count);
    gl.bindVertexArray(null);
  }
}

/** Central-difference gradient of the rendered surface per texel, in world axes (rows run north → south). */
function gradients(d: Float32Array, layer: Layer): Float32Array {
  const n = layer.w;
  const cell = (layer.worldKm * 1000) / n;
  const out = new Float32Array(n * n * 2);
  for (let y = 0; y < n; y++) {
    const yu = Math.max(0, y - 1);
    const yd = Math.min(n - 1, y + 1);
    for (let x = 0; x < n; x++) {
      const xl = Math.max(0, x - 1);
      const xr = Math.min(n - 1, x + 1);
      const h = (i: number): number => d[i];
      out[(y * n + x) * 2] = (h(y * n + xr) - h(y * n + xl)) / ((xr - xl) * cell);
      out[(y * n + x) * 2 + 1] = (h(yu * n + x) - h(yd * n + x)) / ((yd - yu) * cell);
    }
  }
  return out;
}

/** Rasters for realistic colouring (from the climate and biome stages). */
export interface SurfaceLayers {
  temperature: Layer;
  aridity: Layer;
  summerRain: Layer | null;
  canopy: Layer;
  snow: Layer;
  biome: Layer;
  /** Seasonal temperature half-range (°C) and precipitation (mm/yr), for seasons and clouds (M9). */
  tempRange?: Layer | null;
  precip?: Layer | null;
}

/** Leaf type per biome (M9): deciduous and conifer shares. */
function leafType(id: number): [number, number] {
  switch (id) {
    case BIOME.TEMP_BROADLEAF: return [0.85, 0.1];
    case BIOME.BOREAL: return [0.15, 0.85];
    case BIOME.TEMP_CONIFER: return [0.05, 0.9];
    case BIOME.TEMP_RAINFOREST: return [0.1, 0.6];
    case BIOME.CLOUD_FOREST: return [0, 0.25];
    case BIOME.MEDITERRANEAN: return [0.1, 0.3];
    case BIOME.SWAMP: return [0.35, 0.15];
    case BIOME.FEN: return [0.3, 0.3];
    default: return [0, 0];
  }
}

/**
 * Season and cloud inputs on the climate grid: r seasonal half-range (/30 °C), g cloudiness from
 * precipitation (or the aridity index) blurred over ~10 cells, b deciduous and a conifer shares
 * (blurred 3×3 like the cover masks).
 */
function climate2(s: SurfaceLayers, n: number): Uint8Array {
  const N = n * n;
  const amp = s.tempRange && s.tempRange.w === n ? s.tempRange.data : null;
  const pr = s.precip && s.precip.w === n ? s.precip.data : null;
  const wet = new Float32Array(N);
  const dec = new Float32Array(N);
  const con = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    wet[i] = 0.12 + 0.78 * (pr ? smooth(150, 2200, pr[i]) : smooth(0.1, 1.6, s.aridity.data[i]));
    [dec[i], con[i]] = leafType(s.biome.data[i]);
  }
  // Clouds are large: two box passes of radius 5 cells approximate a Gaussian.
  const cloud = boxBlur(boxBlur(wet, n, 5), n, 5);
  const decB = boxBlur(dec, n, 1);
  const conB = boxBlur(con, n, 1);
  const out = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    out[i * 4] = Math.round(255 * Math.min(1, Math.max(0, (amp ? amp[i] : 10) / 30)));
    out[i * 4 + 1] = Math.round(255 * cloud[i]);
    out[i * 4 + 2] = Math.round(255 * decB[i]);
    out[i * 4 + 3] = Math.round(255 * conB[i]);
  }
  return out;
}

/** Separable box blur with clamped edges. */
function boxBlur(src: Float32Array, n: number, r: number): Float32Array {
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let acc = 0;
      for (let d = -r; d <= r; d++) acc += src[y * n + Math.min(n - 1, Math.max(0, x + d))];
      tmp[y * n + x] = acc * k;
    }
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let acc = 0;
      for (let d = -r; d <= r; d++) acc += tmp[Math.min(n - 1, Math.max(0, y + d)) * n + x];
      out[y * n + x] = acc * k;
    }
  }
  return out;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Cover masks from biome ids and snow, blurred over 3×3 cells: r snow/ice, g rock, b sand, a marsh. */
function coverMasks(biome: Layer, snow: Layer, n: number): Uint8Array {
  const raw = new Float32Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const id = biome.data[i];
    raw[i * 4] = Math.max(snow.data[i], id === BIOME.ICE ? 1 : 0);
    raw[i * 4 + 1] = id === BIOME.ROCK || id === BIOME.NIVAL ? 1 : 0;
    raw[i * 4 + 2] = id === BIOME.BEACH || id === BIOME.SALT_FLAT ? 1 : 0;
    raw[i * 4 + 3] = id === BIOME.MARSH || id === BIOME.BOG || id === BIOME.SALT_MARSH || id === BIOME.MANGROVE || id === BIOME.SWAMP || id === BIOME.FEN ? 1 : 0;
  }
  const out = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = Math.min(n - 1, Math.max(0, x + dx));
            const ny = Math.min(n - 1, Math.max(0, y + dy));
            acc += raw[(ny * n + nx) * 4 + c];
          }
        }
        out[(y * n + x) * 4 + c] = Math.round((255 * acc) / 9);
      }
    }
  }
  return out;
}

function linearTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  return t;
}

/** 2×2 box-filtered half-resolution copy of an interleaved RG raster. */
function halveRG(src: Float32Array, n: number): Float32Array {
  const h = n >> 1;
  const out = new Float32Array(h * h * 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < h; x++) {
      for (let c = 0; c < 2; c++) {
        const a = ((2 * y) * n + 2 * x) * 2 + c;
        out[(y * h + x) * 2 + c] = 0.25 * (src[a] + src[a + 2] + src[a + 2 * n] + src[a + 2 * n + 2]);
      }
    }
  }
  return out;
}

/** Wetland / salt-flat coverage masks, blurred over 3×3 cells so tints have soft, non-blocky edges. */
function surfaceMasks(cls: Float32Array, n: number): Uint8Array {
  const out = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let wet = 0;
      let salt = 0;
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = Math.min(n - 1, Math.max(0, x + dx));
          const ny = Math.min(n - 1, Math.max(0, y + dy));
          const c = cls[ny * n + nx];
          if (c === 4) wet++;
          if (c === 5) salt++;
          k++;
        }
      }
      const o = (y * n + x) * 4;
      out[o] = (255 * wet) / k;
      out[o + 1] = (255 * salt) / k;
      out[o + 3] = 255;
    }
  }
  return out;
}

function floatTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array([0]));
  return t;
}

function upload(gl: WebGL2RenderingContext, tex: WebGLTexture, layer: Layer): void {
  uploadData(gl, tex, layer.data instanceof Float32Array ? layer.data : Float32Array.from(layer.data), layer.w);
}

function uploadData(gl: WebGL2RenderingContext, tex: WebGLTexture, data: Float32Array, n: number): void {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, n, n, 0, gl.RED, gl.FLOAT, data);
}
