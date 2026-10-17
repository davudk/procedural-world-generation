import { surfaceDir } from '../../shared/cube';
import { RIVER, type RiverGraph } from '../../shared/protocol';
import { compileProgram, uniforms } from '../gl/util';
import { bindGlobeAtmos, GLOBE_ATMOS_GLSL, TERRAIN_AIR_K, TERRAIN_TONE_GLSL, type GlobeAtmosFrame } from '../globe/atmosphere';

/**
 * Floats per vertex: unit direction xyz and water surface (m), unit side vector xyz (in the tangent
 * plane) and side sign, then width (m), drainage area (km²), along (m) and flags.
 */
const VERT_FLOATS = 12;

const VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_dirZ;     // unit direction (planet axes), water surface (m)
layout(location = 1) in vec4 a_side;     // unit side vector, sign
layout(location = 2) in vec4 a_info;     // width, area, along, flags
uniform mat4 u_viewProj;
uniform float u_radius;
uniform float u_exag;
uniform float u_pxScale;   // metres per pixel per metre of distance: 2·tan(fov/2)/viewH
uniform float u_minPx;
uniform float u_lodC;      // A_vis = (lodC · m/px / 1000)² km²
uniform vec3 u_sunReal;
uniform float u_realK;
uniform vec3 u_lightCol, u_ambient;
${GLOBE_ATMOS_GLSL}
out float v_alpha;
out float v_along;
out float v_side;
out float v_flags;
out float v_widthPx;
out vec3 v_light;
out vec3 v_air;
out vec3 v_trans;

// The globe terrain's sun-model colours for a local sun elevation (globePass.ts dayLight).
void dayLight(float mu, out vec3 light, out vec3 amb) {
  float day = smoothstep(-0.05, 0.08, mu);
  float warm = 1.0 - smoothstep(0.05, 0.45, mu);
  float night = 1.0 - smoothstep(-0.12, 0.0, mu);
  light = mix(vec3(1.0), vec3(1.0, 0.62, 0.36), warm) * day * (1.0 - 0.3 * warm) + vec3(0.55, 0.68, 1.0) * 0.22 * night * 0.5;
  float fill = 1.0 + 0.5 * warm * day;
  amb = mix(vec3(0.10, 0.13, 0.24) * 0.6, mix(vec3(fill), vec3(1.08, 0.92, 0.86) * fill, warm * day), smoothstep(-0.14, 0.25, mu));
}

void main() {
  vec3 up = a_dirZ.xyz;
  // Eye-relative position: both terms are float32 planet-scale values, so the error stays near the
  // representation step of the radius (cm on small planets, under a metre at Earth radius).
  vec3 rel = up * (u_radius + a_dirZ.w * u_exag) - u_eyeP;
  float dist = max(1.0, length(rel));
  float mpp = dist * u_pxScale;
  float aVis = pow(u_lodC * mpp / 1000.0, 2.0);
  v_alpha = smoothstep(aVis, aVis * 1.8, a_info.y);
  float halfW = max(0.5 * a_info.x, 0.5 * u_minPx * mpp);
  v_widthPx = 2.0 * halfW / mpp;
  // Lift slightly along the local vertical so the ribbon wins against the (coarser) terrain surface.
  rel += up * max(2.0, 0.0008 * dist);
  rel += a_side.xyz * a_side.w * halfW;
  v_along = a_info.z;
  v_side = a_side.w;
  v_flags = a_info.w;
  vec3 lr, ar;
  dayLight(dot(up, u_sunReal), lr, ar);
  v_light = 0.35 * mix(u_ambient, ar, u_realK) + 0.65 * mix(u_lightCol, lr, u_realK);
  vec3 trans;
  v_air = atmosphereK(u_eyeP, normalize(rel), length(rel), 6, ${TERRAIN_AIR_K.toFixed(2)}, trans);
  v_trans = trans;
  gl_Position = u_viewProj * vec4(rel, 1.0);
  if (v_alpha <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // culled: outside the clip volume
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
in float v_alpha;
in float v_along;
in float v_side;
in float v_flags;
in float v_widthPx;
in vec3 v_light;
in vec3 v_air;
in vec3 v_trans;
uniform float u_time;
${TERRAIN_TONE_GLSL}
out vec4 o;
void main() {
  int flags = int(v_flags + 0.5);
  vec3 col = vec3(0.20, 0.45, 0.56);
  float streak = sin((v_along - u_time * 40.0) * 0.02 + 3.0 * sin(v_side * 2.0 + v_along * 0.003));
  col += 0.05 * smoothstep(0.6, 1.0, streak) * smoothstep(3.0, 10.0, v_widthPx);
  col *= 1.0 - 0.18 * abs(v_side) * smoothstep(2.0, 6.0, v_widthPx);
  if ((flags & ${RIVER.WATERFALL}) != 0) col = mix(col, vec3(0.92, 0.95, 0.97), 0.6 + 0.2 * sin(u_time * 9.0 + v_along));
  else if ((flags & ${RIVER.RAPIDS}) != 0) col = mix(col, vec3(0.80, 0.88, 0.92), 0.25 * smoothstep(4.0, 12.0, v_widthPx));
  col *= v_light;
  // Aerial perspective and tone mapping as the globe terrain.
  col = col * v_trans + v_air;
  col = terrainTone(col);
  float a = v_alpha;
  if ((flags & ${RIVER.EPHEMERAL}) != 0) a *= step(0.45, fract(v_along / 400.0)) * 0.7;
  a *= mix(0.85, 1.0, smoothstep(1.0, 3.0, v_widthPx)) * (1.0 - smoothstep(0.75, 1.0, abs(v_side)) * 0.6);
  if (a <= 0.01) discard;
  o = vec4(pow(col, vec3(1.0 / 1.1)), a);
}`;

export interface GlobeRiverFrame {
  viewProj: Float32Array;
  exaggeration: number;
  pxScale: number;
  time: number;
  sunReal: readonly [number, number, number];
  realK: number;
  light: readonly [number, number, number];
  ambient: readonly [number, number, number];
  atmos: GlobeAtmosFrame;
}

/**
 * River ribbons on the globe (research 10 §6.6): the flat RiverPass's ribbons built from a sphere
 * river graph (face, u, v per node; RiverGraph docs), placed along each node's direction at R + the
 * water surface, with the side vector in the local tangent plane and a radial lift. Drawn after the
 * globe terrain with its depth buffer, so the far side and hills hide them.
 */
export class GlobeRiverPass {
  private readonly prog: WebGLProgram;
  private readonly u;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly ibo: WebGLBuffer;
  private indexCount = 0;
  private radius = 1;
  minPx = 1.3;
  lodC = 49;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.prog = compileProgram(gl, 'globeRivers', VS, FS);
    this.u = uniforms(gl, this.prog, [
      'u_viewProj', 'u_radius', 'u_exag', 'u_pxScale', 'u_minPx', 'u_lodC', 'u_time', 'u_sunReal', 'u_realK', 'u_lightCol', 'u_ambient',
    ] as const);
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.ibo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const stride = VERT_FLOATS * 4;
    for (let a = 0; a < 3; a++) {
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 4, gl.FLOAT, false, stride, a * 16);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bindVertexArray(null);
  }

  /** Builds ribbons for every reach (plus its junction node) of a sphere river graph. */
  setRivers(g: RiverGraph | null, radiusM: number): void {
    const gl = this.gl;
    this.radius = radiusM;
    const built = g && g.face ? globeRiverVertices(g, radiusM) : null;
    if (!built) {
      this.indexCount = 0;
      return;
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, built.verts, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, built.idx, gl.STATIC_DRAW);
    this.indexCount = built.idx.length;
  }

  draw(f: GlobeRiverFrame): void {
    if (this.indexCount === 0) return;
    const gl = this.gl;
    const u = this.u;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(u.u_viewProj, false, f.viewProj);
    gl.uniform1f(u.u_radius, this.radius);
    gl.uniform1f(u.u_exag, f.exaggeration);
    gl.uniform1f(u.u_pxScale, f.pxScale);
    gl.uniform1f(u.u_minPx, this.minPx);
    gl.uniform1f(u.u_lodC, this.lodC);
    gl.uniform1f(u.u_time, f.time);
    gl.uniform3f(u.u_sunReal, f.sunReal[0], f.sunReal[1], f.sunReal[2]);
    gl.uniform1f(u.u_realK, f.realK);
    gl.uniform3f(u.u_lightCol, f.light[0], f.light[1], f.light[2]);
    gl.uniform3f(u.u_ambient, f.ambient[0], f.ambient[1], f.ambient[2]);
    bindGlobeAtmos(gl, this.prog, f.atmos);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
}

/** Ribbon vertices and triangle indices of a sphere river graph (exported for tests). */
export function globeRiverVertices(g: RiverGraph, radiusM: number): { verts: Float32Array; idx: Uint32Array } | null {
  const face = g.face;
  if (!face || g.n === 0) return null;
  // Node directions (float64) once.
  const dir = new Float64Array(3 * g.n);
  for (let i = 0; i < g.n; i++) surfaceDir(face[i], g.x[i], g.y[i], radiusM, dir, 3 * i);
  const reaches = g.reachStart.length;
  let nodes = 0;
  for (let r = 0; r < reaches; r++) nodes += g.reachLen[r] + 1;
  const verts = new Float32Array(nodes * 2 * VERT_FLOATS);
  const idx = new Uint32Array(nodes * 6);
  let v = 0;
  let k = 0;
  const ids: number[] = [];
  const dist = (a: number, b: number): number =>
    radiusM * Math.hypot(dir[3 * b] - dir[3 * a], dir[3 * b + 1] - dir[3 * a + 1], dir[3 * b + 2] - dir[3 * a + 2]);
  for (let r = 0; r < reaches; r++) {
    ids.length = 0;
    const s0 = g.reachStart[r];
    for (let j = 0; j < g.reachLen[r]; j++) ids.push(s0 + j);
    const last = ids[ids.length - 1];
    if (g.down[last] >= 0) ids.push(g.down[last]);
    if (ids.length < 2) continue;
    let along = 0;
    const base = v;
    for (let j = 0; j < ids.length; j++) {
      const i = ids[j];
      const a = ids[Math.max(0, j - 1)];
      const b = ids[Math.min(ids.length - 1, j + 1)];
      const ux = dir[3 * i];
      const uy = dir[3 * i + 1];
      const uz = dir[3 * i + 2];
      // Side = up × tangent, in the tangent plane.
      const tx = dir[3 * b] - dir[3 * a];
      const ty = dir[3 * b + 1] - dir[3 * a + 1];
      const tz = dir[3 * b + 2] - dir[3 * a + 2];
      let sx = uy * tz - uz * ty;
      let sy = uz * tx - ux * tz;
      let sz = ux * ty - uy * tx;
      const sl = Math.hypot(sx, sy, sz) || 1;
      sx /= sl;
      sy /= sl;
      sz /= sl;
      if (j > 0) along += dist(ids[j - 1], i);
      const src = j === ids.length - 1 && ids.length > g.reachLen[r] ? ids[j - 1] : i;
      for (const side of [-1, 1]) {
        const o = v * VERT_FLOATS;
        verts[o] = ux;
        verts[o + 1] = uy;
        verts[o + 2] = uz;
        verts[o + 3] = g.zWater[i];
        verts[o + 4] = sx;
        verts[o + 5] = sy;
        verts[o + 6] = sz;
        verts[o + 7] = side;
        verts[o + 8] = g.width[src];
        verts[o + 9] = g.area[src];
        verts[o + 10] = along;
        verts[o + 11] = g.flags[i];
        v++;
      }
    }
    for (let j = 0; j < ids.length - 1; j++) {
      const a = base + 2 * j;
      idx[k++] = a;
      idx[k++] = a + 1;
      idx[k++] = a + 2;
      idx[k++] = a + 1;
      idx[k++] = a + 3;
      idx[k++] = a + 2;
    }
  }
  return { verts: verts.subarray(0, v * VERT_FLOATS), idx: idx.subarray(0, k) };
}
