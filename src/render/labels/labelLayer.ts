import type { Landmark } from '../../shared/landmarks';
import type { GroundQuery } from '../camera/ground';
import type { OrbitCamera } from '../camera/orbitCamera';
import { compileProgram, uniforms } from '../gl/util';
import { GlyphAtlas } from './glyphAtlas';
import { INSTANCE_FLOATS, LabelEngine, type LabelStats } from './labelEngine';

const VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;   // 0..1
layout(location = 1) in vec4 a_pos;      // glyph centre x, y (CSS px), angle, style
layout(location = 2) in vec4 a_quad;     // glyph-local quad ox, oy, w, h (CSS px)
layout(location = 3) in vec4 a_rect;     // atlas rect (px)
layout(location = 4) in vec4 a_misc;     // opacity, emphasis, highlight, CSS px per atlas px
uniform vec2 u_view;     // CSS px
uniform vec2 u_atlas;    // atlas size (px)
uniform float u_spread;  // SDF spread (atlas px)
out vec2 v_uv;
out float v_k;
flat out vec4 v_misc;
flat out float v_style;
void main() {
  vec2 local = a_quad.xy + a_corner * a_quad.zw;
  float c = cos(a_pos.z), s = sin(a_pos.z);
  vec2 p = a_pos.xy + vec2(c * local.x - s * local.y, s * local.x + c * local.y);
  gl_Position = vec4(p.x / u_view.x * 2.0 - 1.0, 1.0 - p.y / u_view.y * 2.0, 0.0, 1.0);
  v_uv = (a_rect.xy + a_corner * a_rect.zw) / u_atlas;
  v_k = 1.0 / (2.0 * u_spread * a_misc.w);   // SDF value change per CSS px
  v_misc = a_misc;
  v_style = a_pos.w;
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
in float v_k;
flat in vec4 v_misc;
flat in float v_style;
uniform sampler2D u_tex;
uniform float u_dpr;
uniform vec3 u_landText;
uniform vec4 u_landHalo;
uniform vec3 u_waterText;
uniform vec4 u_waterHalo;
uniform vec4 u_hlHalo;
out vec4 o;
void main() {
  float d = texture(u_tex, v_uv).r;
  float emph = v_misc.y, hl = v_misc.z;
  float aa = 0.6 * v_k / u_dpr;                        // ~0.6 device px of anti-aliasing
  float edge = 0.5 - emph * 0.3 * v_k;                 // heroes: ~0.3 CSS px bolder
  float text = smoothstep(edge - aa, edge + aa, d);
  float haloPx = 1.7 + 0.3 * emph + 0.6 * hl;
  float he = max(0.02, edge - haloPx * v_k);
  float halo = smoothstep(he - aa - 0.8 * v_k, he + aa, d);   // soft outer edge
  bool water = v_style > 0.5;
  vec3 tc = water ? u_waterText : u_landText;
  vec4 hc = water ? u_waterHalo : u_landHalo;
  hc = mix(hc, u_hlHalo, hl);
  float ha = halo * hc.a * (1.0 - text);
  float a = text + ha;
  if (a * v_misc.x < 0.004) discard;
  vec3 premul = tc * text + hc.rgb * ha;
  o = vec4(premul, a) * v_misc.x;                      // premultiplied, faded
}`;

export interface LabelDrawFrame {
  cam: OrbitCamera;
  ground: GroundQuery;
  dpr: number;
  timeSec: number;
  exaggeration: number;
}

/**
 * Map labels (M7, research 04 §5.2): SDF glyph atlas + instanced screen-space quads, greedy priority
 * placement with hysteresis and fades. Draw after the terrain and water into the bound framebuffer.
 */
export class LabelLayer {
  enabled = true;
  readonly atlas: GlyphAtlas;
  readonly engine: LabelEngine;
  /** Colours (linear-ish RGB, halo with alpha); tunable from the console. */
  colors = {
    landText: [0.10, 0.09, 0.08] as [number, number, number],
    landHalo: [0.98, 0.96, 0.91, 0.82] as [number, number, number, number],
    waterText: [0.80, 0.91, 1.0] as [number, number, number],
    waterHalo: [0.03, 0.12, 0.23, 0.72] as [number, number, number, number],
    highlightHalo: [1.0, 0.82, 0.30, 0.95] as [number, number, number, number],
  };
  private readonly prog: WebGLProgram;
  private readonly u;
  private readonly vao: WebGLVertexArrayObject;
  private readonly cornerBuf: WebGLBuffer;
  private readonly instBuf: WebGLBuffer;
  private instCapacity = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.atlas = new GlyphAtlas(gl);
    this.engine = new LabelEngine(this.atlas);
    this.prog = compileProgram(gl, 'labels', VS, FS);
    this.u = uniforms(gl, this.prog, ['u_view', 'u_atlas', 'u_spread', 'u_tex', 'u_dpr', 'u_landText', 'u_landHalo', 'u_waterText', 'u_waterHalo', 'u_hlHalo'] as const);
    this.vao = gl.createVertexArray();
    this.cornerBuf = gl.createBuffer();
    this.instBuf = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    const stride = INSTANCE_FLOATS * 4;
    for (let a = 0; a < 4; a++) {
      gl.enableVertexAttribArray(1 + a);
      gl.vertexAttribPointer(1 + a, 4, gl.FLOAT, false, stride, a * 16);
      gl.vertexAttribDivisor(1 + a, 1);
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  setLandmarks(list: readonly Landmark[], worldM: number): void {
    this.engine.setLandmarks(list, worldM);
  }

  highlight(id: number | null): void {
    this.engine.highlight(id);
  }

  hitTest(sx: number, sy: number): Landmark | null {
    return this.enabled ? this.engine.hitTest(sx, sy) : null;
  }

  /** True while labels fade or newcomers wait to be shown (an on-demand renderer should keep drawing). */
  get animating(): boolean {
    return this.enabled && this.engine.animating;
  }

  get stats(): LabelStats {
    return this.engine.stats;
  }

  /** Places and draws labels for this frame into the currently bound framebuffer (viewport already set). */
  draw(frame: LabelDrawFrame): void {
    if (!this.enabled) return;
    const e = this.engine;
    e.update(frame);
    if (e.instanceCount === 0) return;
    const gl = this.gl;
    this.atlas.flush();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    const data = e.instances.subarray(0, e.instanceCount * INSTANCE_FLOATS);
    if (data.length > this.instCapacity) {
      this.instCapacity = Math.max(data.length, this.instCapacity * 2, INSTANCE_FLOATS * 256);
      gl.bufferData(gl.ARRAY_BUFFER, this.instCapacity * 4, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    gl.useProgram(this.prog);
    const u = this.u;
    const c = this.colors;
    gl.uniform2f(u.u_view, frame.cam.viewW, frame.cam.viewH);
    gl.uniform2f(u.u_atlas, this.atlas.width, this.atlas.height);
    gl.uniform1f(u.u_spread, this.atlas.spread);
    gl.uniform1f(u.u_dpr, Math.max(1, frame.dpr));
    gl.uniform3fv(u.u_landText, c.landText);
    gl.uniform4fv(u.u_landHalo, c.landHalo);
    gl.uniform3fv(u.u_waterText, c.waterText);
    gl.uniform4fv(u.u_waterHalo, c.waterHalo);
    gl.uniform4fv(u.u_hlHalo, c.highlightHalo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas.texture);
    gl.uniform1i(u.u_tex, 0);

    const depthWas = gl.isEnabled(gl.DEPTH_TEST);
    const cullWas = gl.isEnabled(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, e.instanceCount);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    if (depthWas) gl.enable(gl.DEPTH_TEST);
    if (cullWas) gl.enable(gl.CULL_FACE);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.prog);
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.cornerBuf);
    gl.deleteBuffer(this.instBuf);
    this.atlas.dispose();
  }
}
