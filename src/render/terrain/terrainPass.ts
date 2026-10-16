import type { Layer, LayerKind } from '../../shared/protocol';
import { compileProgram, uniforms } from '../gl/util';
import { COLORMAPS_GLSL } from '../glsl/colormaps';
import { GRID, INSTANCE_FLOATS, MAX_NODES } from './cdlod';

const HEIGHT_GLSL = /* glsl */ `
uniform sampler2D u_height;   // R32F, row 0 = north
uniform int u_hn;             // height raster size (cells per side)
uniform float u_size;         // world size (m)
uniform vec3 u_origin;        // camera-relative origin (world m), split hi/lo not needed below 4096 km for M2

float hFetch(ivec2 t) { return texelFetch(u_height, clamp(t, ivec2(0), ivec2(u_hn - 1)), 0).r; }

// Manual bilinear (R32F is not filterable everywhere; research 04 §1.3). w = world xy (m).
float rawHeight(vec2 w) {
  vec2 p = vec2(w.x, u_size - w.y) / u_size * float(u_hn) - 0.5;
  ivec2 i = ivec2(floor(p));
  vec2 f = p - vec2(i);
  float a = hFetch(i), b = hFetch(i + ivec2(1, 0)), c = hFetch(i + ivec2(0, 1)), d = hFetch(i + ivec2(1, 1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
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
  float h0 = rawHeight(w0);
  float d0 = length(vec3(rel0, max(h0, 0.0) * u_exag - u_origin.z));
  // Geomorph toward the coarser grid near the end of this level's range.
  float k = clamp((d0 - a_morph.x) / (a_morph.y - a_morph.x), 0.0, 1.0);
  vec2 g = a_grid - fract(a_grid * 0.5) * 2.0 * k;
  vec2 rel = a_node.xy + g / ${GRID}.0 * size;
  vec2 w = rel + u_origin.xy;
  float h = rawHeight(w);
  float z = max(h, 0.0) * u_exag;          // water lid: the sea surface is at 0
  vec3 pos = vec3(rel, z - u_origin.z);
  v_world = vec3(w, h);
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
uniform sampler2D u_grad;    // RG32F: dh/dx, dh/dy (world axes) at texel centres
uniform sampler2D u_layer;   // optional draped layer
uniform ivec2 u_layerSize;
uniform int u_layerMode;     // 0 realistic, 1 categorical, 2 scalar
uniform float u_layerMin, u_layerMax;
${HEIGHT_GLSL}
${COLORMAPS_GLSL}
out vec4 o;

vec2 gFetch(ivec2 t) { return texelFetch(u_grad, clamp(t, ivec2(0), ivec2(u_hn - 1)), 0).rg; }
// Bilinear gradient: smooth normals instead of per-cell facets from differentiating bilinear heights.
vec2 gradAt(vec2 w) {
  vec2 p = vec2(w.x, u_size - w.y) / u_size * float(u_hn) - 0.5;
  ivec2 i = ivec2(floor(p));
  vec2 f = p - vec2(i);
  return mix(mix(gFetch(i), gFetch(i + ivec2(1, 0)), f.x), mix(gFetch(i + ivec2(0, 1)), gFetch(i + ivec2(1, 1)), f.x), f.y);
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
  vec2 gr = gradAt(w);
  vec3 n = normalize(vec3(-gr * u_normalExag, 1.0));

  vec3 col;
  if (h < 0.0 && u_layerMode == 0) {
    // Water: depth colour, soft sun glint, a bright line where it meets the shore.
    float depth = -h;
    vec3 shallow = vec3(0.24, 0.56, 0.62), deep = vec3(0.03, 0.10, 0.22);
    col = mix(shallow, deep, pow(clamp(depth / 4000.0, 0.0, 1.0), 0.35));
    col = mix(col, vec3(0.42, 0.68, 0.70), (1.0 - smoothstep(0.0, 60.0, depth)) * 0.6);
    vec3 nw = normalize(vec3(0.02 * sin(w.x * 0.004 + u_time * 0.6), 0.02 * cos(w.y * 0.0043 - u_time * 0.5), 1.0));
    float spec = pow(max(dot(reflect(-u_sun, nw), vec3(0.0, 0.0, 1.0)), 0.0), 60.0);
    col += spec * 0.12;
    float shore = 1.0 - smoothstep(0.0, max(4.0, fwidth(h) * 1.5), depth);
    col = mix(col, vec3(0.80, 0.86, 0.85), shore * 0.5);
  } else {
    if (u_layerMode == 1) col = categorical(floor(layerAt(w, true) + 0.5));
    else if (u_layerMode == 2) col = viridis((layerAt(w, false) - u_layerMin) / max(1e-6, u_layerMax - u_layerMin));
    else col = hypsometric(h);
    float lambert = max(dot(n, u_sun), 0.0);
    float sky = 0.5 + 0.5 * n.z;
    col *= 0.28 * sky + 0.95 * lambert;
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
      'u_time', 'u_grad', 'u_layer', 'u_layerSize', 'u_layerMode', 'u_layerMin', 'u_layerMax',
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
  }

  setHeight(layer: Layer): void {
    upload(this.gl, this.heightTex, layer);
    this.hn = layer.w;
    this.size = layer.worldKm * 1000;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.gradTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, layer.w, layer.h, 0, gl.RG, gl.FLOAT, gradients(layer));
  }

  /** Drapes a layer's colours over the terrain (null = realistic colouring). */
  setDrape(layer: Layer | null): void {
    if (!layer || layer.kind === 'elevation') {
      this.layerMode = 0;
      return;
    }
    upload(this.gl, this.layerTex, layer);
    this.layerSize = [layer.w, layer.h];
    this.layerMode = LAYER_MODE[layer.kind];
    this.layerMin = layer.min;
    this.layerMax = layer.max;
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
    gl.bindVertexArray(this.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0, f.count);
    gl.bindVertexArray(null);
  }
}

/** Central-difference gradient per texel in world axes (x east, y north; rows run north → south). */
function gradients(layer: Layer): Float32Array {
  const n = layer.w;
  const d = layer.data;
  const cell = (layer.worldKm * 1000) / n;
  const out = new Float32Array(n * n * 2);
  for (let y = 0; y < n; y++) {
    const yu = Math.max(0, y - 1);
    const yd = Math.min(n - 1, y + 1);
    for (let x = 0; x < n; x++) {
      const xl = Math.max(0, x - 1);
      const xr = Math.min(n - 1, x + 1);
      // The water lid is flat: gradients of the sea floor would light the sea surface.
      const h = (i: number): number => Math.max(0, d[i]);
      out[(y * n + x) * 2] = (h(y * n + xr) - h(y * n + xl)) / ((xr - xl) * cell);
      out[(y * n + x) * 2 + 1] = (h(yu * n + x) - h(yd * n + x)) / ((yd - yu) * cell);
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
  const data = layer.data instanceof Float32Array ? layer.data : Float32Array.from(layer.data);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, layer.w, layer.h, 0, gl.RED, gl.FLOAT, data);
}
