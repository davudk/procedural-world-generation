import type { Layer, LayerKind } from '../../shared/protocol';
import { compileProgram, uniforms } from '../gl/util';
import { COLORMAPS_GLSL } from '../glsl/colormaps';
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
${HEIGHT_GLSL}
out vec3 v_world;     // absolute world xy, raw elevation (m)
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
  float z = surfaceHeight(w) * u_exag;     // water lid: sea at 0, lakes at their level
  vec3 pos = vec3(rel, z - u_origin.z);
  v_world = vec3(w, rawHeight(w));
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
uniform sampler2D u_lut;     // biome colour LUT over (T, aridity), and its dry-summer variant
uniform sampler2D u_lutDry;
uniform sampler2D u_biomePal; // 32×1 biome colours (biome map mode)
uniform int u_hasSurface;
uniform int u_palette;       // 0 biome LUT (satellite / stylised), 1 hypsometric
uniform sampler2D u_layer;   // optional draped layer
uniform ivec2 u_layerSize;
uniform int u_layerMode;     // 0 realistic, 1 categorical, 2 scalar, 3 biome palette
uniform float u_layerMin, u_layerMax;
${HEIGHT_GLSL}
${COLORMAPS_GLSL}
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

// Biome colour from climate (research 03 §3.4, §5.3): LUT over jittered (T, aridity), dry-summer
// blend, colour variation at three scales, canopy, then overrides (sand, marsh, rock, snow).
vec3 landColor(vec2 w, float h, vec3 n, float pxFoot) {
  vec2 uv = vec2(w.x, u_size - w.y) / u_size;
  vec4 cl = texture(u_climate, uv);
  vec4 cv = texture(u_cover, uv);
  // Footprint fade so sub-pixel noise doesn't shimmer.
  float fine = 1.0 - smoothstep(600.0, 2500.0, pxFoot);
  float t = cl.r + 3.0 * (fbm3(w / 35000.0) - 0.5);
  float ai = max(0.02, cl.g) * exp(0.4 * (fbm3(w / 28000.0 + 11.0) - 0.5));
  vec2 luv = vec2((t + 20.0) / 50.0, log(ai * 10.0) / log(10.0) / 2.0);
  vec3 c = mix(texture(u_lut, luv).rgb, texture(u_lutDry, luv).rgb, smoothstep(0.45, 0.30, cl.b));
  c *= 0.88 + 0.24 * fbm3(w / 90000.0 + 3.0);                    // geology scale
  c *= mix(1.0, 0.9 + 0.2 * vnoise(w / 3500.0), fine);           // field / patch mosaic
  c *= 1.0 - 0.1 * cl.a;                                         // dense canopy reads darker
  c = mix(c, vec3(0.86, 0.80, 0.66), smoothstep(0.15, 0.7, cv.b) * 0.9);   // beach / dunes / salt
  c = mix(c, vec3(0.24, 0.32, 0.22), smoothstep(0.15, 0.8, cv.a) * 0.5);   // marsh / bog / mangrove
  float slope = length(gradAt(w));
  float rock = max(smoothstep(0.2, 0.75, cv.g), smoothstep(0.35, 0.75, slope));
  vec3 rockCol = vec3(0.44, 0.42, 0.40) * (0.85 + 0.3 * fbm3(w / 6000.0));
  c = mix(c, rockCol, rock * 0.85);
  // Snow lingers on poleward (north-facing) and gentle slopes; elevation noise breaks the snowline.
  float snow = cv.r + 0.15 * n.y + 0.35 * (fbm3(w / 7000.0) - 0.5) + 0.15 * (vnoise(w / 1800.0) - 0.5) * fine
    - 0.3 * smoothstep(0.6, 1.2, slope);
  c = mix(c, vec3(0.93, 0.95, 0.98), smoothstep(0.3, 0.75, snow) * 0.92);
  return c;
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
  float h = rawHeight(w);
  vec2 wp = vec2(w.x, u_size - w.y) / u_size * float(u_hn);
  float cls = u_hasClass == 1 ? texelFetch(u_wclass, clamp(ivec2(floor(wp)), ivec2(0), ivec2(u_hn - 1)), 0).r : (h < 0.0 ? 1.0 : 0.0);
  float wl = waterLevelAt(w);
  bool lake = cls > 1.5 && cls < 2.5 || cls > 5.5;
  bool water = u_hasWater == 1 ? wl > h && (lake || cls > 0.5 && cls < 1.5) : h < 0.0;
  vec2 gr = gradAt(w);
  vec3 n = normalize(vec3(-gr * u_normalExag, 1.0));

  vec3 col;
  if (water && u_layerMode == 0) {
    // Water: depth colour, soft sun glint, a bright line where it meets the shore.
    float depth = lake ? max(0.0, wl - h) : -h;
    vec3 shallow = vec3(0.24, 0.56, 0.62), deep = vec3(0.03, 0.10, 0.22);
    if (lake) { shallow = vec3(0.22, 0.48, 0.52); deep = vec3(0.05, 0.16, 0.24); }
    if (cls > 5.5) { shallow = vec3(0.55, 0.78, 0.76); deep = vec3(0.30, 0.58, 0.62); }
    col = mix(shallow, deep, pow(clamp(depth / (lake ? 400.0 : 4000.0), 0.0, 1.0), 0.35));
    col = mix(col, vec3(0.42, 0.68, 0.70), (1.0 - smoothstep(0.0, 60.0, depth)) * 0.6);
    vec3 nw = normalize(vec3(0.02 * sin(w.x * 0.004 + u_time * 0.6), 0.02 * cos(w.y * 0.0043 - u_time * 0.5), 1.0));
    float spec = pow(max(dot(reflect(-u_sun, nw), vec3(0.0, 0.0, 1.0)), 0.0), 60.0);
    col += spec * 0.12;
    float shore = 1.0 - smoothstep(0.0, max(4.0, fwidth(h) * 1.5), depth);
    col = mix(col, vec3(0.80, 0.86, 0.85), shore * 0.5);
  } else {
    if (u_layerMode == 1) col = categorical(floor(layerAt(w, true) + 0.5));
    else if (u_layerMode == 2) col = viridis((layerAt(w, false) - u_layerMin) / max(1e-6, u_layerMax - u_layerMin));
    else if (u_layerMode == 3) col = pow(texelFetch(u_biomePal, ivec2(int(layerAt(w, true) + 0.5), 0), 0).rgb, vec3(1.1));
    else if (u_hasSurface == 1 && u_palette == 0) col = landColor(w, h, n, length(fwidth(w)));
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
    col *= biomeLit ? 0.30 * sky + 1.25 * lambert : 0.28 * sky + 0.95 * lambert;
  }
  col = mix(col, u_hazeColor, 1.0 - exp(-v_dist * u_haze));
  o = vec4(pow(col, vec3(1.0 / 1.1)), 1.0);
}`;

const LAYER_MODE: Record<LayerKind, number> = { elevation: 0, categorical: 1, scalar: 2 };

export interface TerrainFrame {
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
  private readonly lutDryTex: WebGLTexture;
  private readonly paletteTex: WebGLTexture;
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
      'u_viewProj', 'u_exag', 'u_height', 'u_hn', 'u_size', 'u_origin', 'u_sun', 'u_normalExag', 'u_cell', 'u_haze', 'u_hazeColor',
      'u_time', 'u_grad', 'u_water', 'u_hasWater', 'u_wclass', 'u_hasClass', 'u_masks', 'u_climate', 'u_cover', 'u_lut', 'u_lutDry',
      'u_biomePal', 'u_hasSurface', 'u_palette', 'u_layer', 'u_layerSize', 'u_layerMode', 'u_layerMin', 'u_layerMax',
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
    this.lutDryTex = linearTexture(gl);
    this.paletteTex = linearTexture(gl);
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
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, LUT_SIZE, LUT_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildBiomeLut(p, false));
    gl.bindTexture(gl.TEXTURE_2D, this.lutDryTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, LUT_SIZE, LUT_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildBiomeLut(p, true));
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
    gl.uniform1f(this.u.u_exag, f.exaggeration);
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
    bind(9, this.lutDryTex, this.u.u_lutDry);
    bind(10, this.paletteTex, this.u.u_biomePal);
    gl.uniform1i(this.u.u_hasSurface, this.hasSurface);
    gl.uniform1i(this.u.u_palette, this.palette === 'hypsometric' ? 1 : 0);
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
}

/** Cover masks from biome ids and snow, blurred over 3×3 cells: r snow/ice, g rock, b sand, a marsh. */
function coverMasks(biome: Layer, snow: Layer, n: number): Uint8Array {
  const raw = new Float32Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const id = biome.data[i];
    raw[i * 4] = Math.max(snow.data[i], id === BIOME.ICE ? 1 : 0);
    raw[i * 4 + 1] = id === BIOME.ROCK || id === BIOME.NIVAL ? 1 : 0;
    raw[i * 4 + 2] = id === BIOME.BEACH || id === BIOME.SALT_FLAT ? 1 : 0;
    raw[i * 4 + 3] = id === BIOME.MARSH || id === BIOME.BOG || id === BIOME.SALT_MARSH || id === BIOME.MANGROVE ? 1 : 0;
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
