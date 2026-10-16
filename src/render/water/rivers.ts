import { RIVER, type RiverGraph } from '../../shared/protocol';
import { compileProgram, uniforms } from '../gl/util';
import { ATMOS_GLSL, bindAtmos, type AtmosFrame } from '../lighting/atmosphere';

/** Floats per vertex: centre x, y, z (world m), side x, y, side sign, width (m), area (km²), along (m), flags. */
const VERT_FLOATS = 10;

const VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_center;
layout(location = 1) in vec3 a_side;     // unit side vector xy, sign
layout(location = 2) in vec4 a_info;     // width, area, along, flags
uniform mat4 u_viewProj;
uniform vec3 u_origin;
uniform float u_exag;
uniform float u_pxScale;   // metres per pixel per metre of distance: 2·tan(fov/2)/viewH
uniform float u_minPx;
uniform float u_lodC;      // A_vis = (lodC · m/px / 1000)² km²
out float v_alpha;
out float v_along;
out float v_side;
out float v_flags;
out float v_widthPx;
out vec3 v_world;    // world xy (m), render height
void main() {
  v_world = vec3(a_center.xy, a_center.z * u_exag);
  vec3 rel = a_center - u_origin;
  rel.z = a_center.z * u_exag - u_origin.z;
  float dist = max(1.0, length(rel));
  float mpp = dist * u_pxScale;
  float aVis = pow(u_lodC * mpp / 1000.0, 2.0);
  v_alpha = smoothstep(aVis, aVis * 1.8, a_info.y);
  float halfW = max(0.5 * a_info.x, 0.5 * u_minPx * mpp);
  v_widthPx = 2.0 * halfW / mpp;
  // Lift slightly toward the camera so the ribbon wins against the (coarser) terrain surface.
  rel.z += max(2.0, 0.0008 * dist);
  rel.xy += a_side.xy * a_side.z * halfW;
  v_along = a_info.z;
  v_side = a_side.z;
  v_flags = a_info.w;
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
in vec3 v_world;
uniform float u_time;
uniform int u_atmos;         // 1: light colours, cloud shadows and valley fog (realistic view)
uniform float u_size;
uniform vec3 u_sun;
uniform vec3 u_hazeColor;
uniform sampler2D u_fogPot;  // horizon pass AO texture: b = valley-fog potential
${ATMOS_GLSL}
out vec4 o;
float hash(float x) { return fract(sin(x * 12.9898) * 43758.5453); }
void main() {
  int flags = int(v_flags + 0.5);
  vec3 col = vec3(0.20, 0.45, 0.56);
  // Flow streaks scroll downstream; fade them out on ribbons only a few pixels wide.
  float streak = sin((v_along - u_time * 40.0) * 0.02 + 3.0 * sin(v_side * 2.0 + v_along * 0.003));
  col += 0.05 * smoothstep(0.6, 1.0, streak) * smoothstep(3.0, 10.0, v_widthPx);
  col *= 1.0 - 0.18 * abs(v_side) * smoothstep(2.0, 6.0, v_widthPx);     // darker banks
  if ((flags & ${RIVER.WATERFALL}) != 0) col = mix(col, vec3(0.92, 0.95, 0.97), 0.6 + 0.2 * sin(u_time * 9.0 + v_along));
  else if ((flags & ${RIVER.RAPIDS}) != 0) col = mix(col, vec3(0.80, 0.88, 0.92), 0.25 * smoothstep(4.0, 12.0, v_widthPx));
  if (u_atmos == 1) {
    // Same light as the water lid, so ribbons don't glow at night, under clouds or in fog.
    float foot = max(1.0, length(fwidth(v_world.xy)));
    float cs = cloudShadow(v_world.xy, v_world.z, foot);
    col *= mix(0.85, 1.0, cs) * (0.35 * u_ambient + 0.65 * u_lightCol);
    vec2 uv = vec2(v_world.x, u_size - v_world.y) / u_size;
    col = mix(col, fogColor(), valleyFog(v_world.xy, texture(u_fogPot, uv).b, texture(u_clim2, uv).g, foot));
  }
  float a = v_alpha;
  if ((flags & ${RIVER.EPHEMERAL}) != 0) a *= step(0.45, fract(v_along / 400.0)) * 0.7;  // dashed wadis
  // Soft edges for ribbons that are only a pixel or two wide.
  a *= mix(0.85, 1.0, smoothstep(1.0, 3.0, v_widthPx)) * (1.0 - smoothstep(0.75, 1.0, abs(v_side)) * 0.6);
  if (a <= 0.01) discard;
  o = vec4(pow(col, vec3(1.0 / 1.1)), a);
}`;

export interface RiverFrame {
  viewProj: Float32Array;
  origin: { x: number; y: number; z: number };
  exaggeration: number;
  pxScale: number;
  time: number;
  /** Atmosphere (realistic view) with the horizon pass's fog-potential texture, or null. */
  atmos: { frame: AtmosFrame; fogPot: WebGLTexture; size: number; sun: readonly [number, number, number]; hazeColor: readonly [number, number, number] } | null;
}

/** Rivers as ribbons built once per generation from the river graph (research 02 §9, 04 §4.2). */
export class RiverPass {
  private readonly prog: WebGLProgram;
  private readonly u;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly ibo: WebGLBuffer;
  private indexCount = 0;
  /** Minimum on-screen width (px) and the LOD constant; tunable from the console. */
  minPx = 1.3;
  lodC = 49;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.prog = compileProgram(gl, 'rivers', VS, FS);
    this.u = uniforms(gl, this.prog, ['u_viewProj', 'u_origin', 'u_exag', 'u_pxScale', 'u_minPx', 'u_lodC', 'u_time', 'u_atmos', 'u_size', 'u_sun', 'u_hazeColor', 'u_fogPot'] as const);
    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.ibo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const stride = VERT_FLOATS * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 24);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bindVertexArray(null);
  }

  /** Builds ribbons for every reach (plus its junction node) from a graph in map metres. */
  setRivers(g: RiverGraph | null, worldM: number): void {
    const gl = this.gl;
    if (!g || g.n === 0) {
      this.indexCount = 0;
      return;
    }
    const reaches = g.reachStart.length;
    // Each reach contributes len (+1 junction) nodes, two vertices per node.
    let nodes = 0;
    for (let r = 0; r < reaches; r++) nodes += g.reachLen[r] + 1;
    const verts = new Float32Array(nodes * 2 * VERT_FLOATS);
    const idx = new Uint32Array(nodes * 6);
    let v = 0;
    let k = 0;
    const px: number[] = [];
    const ids: number[] = [];
    for (let r = 0; r < reaches; r++) {
      px.length = 0;
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
        let tx = g.x[b] - g.x[a];
        let ty = -(g.y[b] - g.y[a]); // map y runs south; world y runs north
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl;
        ty /= tl;
        if (j > 0) along += Math.hypot(g.x[i] - g.x[ids[j - 1]], g.y[i] - g.y[ids[j - 1]]);
        // The junction node takes this reach's width so tributaries don't balloon at confluences.
        const src = j === ids.length - 1 && ids.length > g.reachLen[r] ? ids[j - 1] : i;
        for (const side of [-1, 1]) {
          const o = v * VERT_FLOATS;
          verts[o] = g.x[i];
          verts[o + 1] = worldM - g.y[i];
          verts[o + 2] = g.zWater[i];
          verts[o + 3] = -ty;
          verts[o + 4] = tx;
          verts[o + 5] = side;
          verts[o + 6] = g.width[src];
          verts[o + 7] = g.area[src];
          verts[o + 8] = along;
          verts[o + 9] = g.flags[i];
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
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts.subarray(0, v * VERT_FLOATS), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx.subarray(0, k), gl.STATIC_DRAW);
    this.indexCount = k;
  }

  draw(f: RiverFrame): void {
    if (this.indexCount === 0) return;
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.u_viewProj, false, f.viewProj);
    gl.uniform3f(this.u.u_origin, f.origin.x, f.origin.y, f.origin.z);
    gl.uniform1f(this.u.u_exag, f.exaggeration);
    gl.uniform1f(this.u.u_pxScale, f.pxScale);
    gl.uniform1f(this.u.u_minPx, this.minPx);
    gl.uniform1f(this.u.u_lodC, this.lodC);
    gl.uniform1f(this.u.u_time, f.time);
    gl.uniform1i(this.u.u_atmos, f.atmos ? 1 : 0);
    if (f.atmos) {
      const a = f.atmos;
      gl.uniform1f(this.u.u_size, a.size);
      gl.uniform3f(this.u.u_sun, a.sun[0], a.sun[1], a.sun[2]);
      gl.uniform3f(this.u.u_hazeColor, a.hazeColor[0], a.hazeColor[1], a.hazeColor[2]);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, a.fogPot);
      gl.uniform1i(this.u.u_fogPot, 1);
      bindAtmos(gl, this.prog, a.frame, 0);
    }
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
