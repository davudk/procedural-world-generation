import type { Layer, LayerKind } from '../shared/protocol';
import type { Camera } from './camera2d';
import { compileProgram, uniforms } from './gl/util';

const VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;   // unit square
uniform mat3 u_view;
uniform float u_worldKm;
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  vec3 c = u_view * vec3(a_pos * u_worldKm, 1.0);
  gl_Position = vec4(c.xy, 0.0, 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform ivec2 u_size;
uniform int u_mode;          // 0 elevation, 1 categorical, 2 scalar
uniform float u_min, u_max;
uniform float u_cellM;       // cell size in metres
uniform float u_exag;        // hillshade exaggeration
out vec4 o;

float fetchC(ivec2 t) { return texelFetch(u_tex, clamp(t, ivec2(0), u_size - 1), 0).r; }

// Manual bilinear: R32F is not filterable everywhere (research 04 §1.3).
float heightAt(vec2 p) {
  vec2 q = p - 0.5;
  ivec2 i = ivec2(floor(q));
  vec2 f = q - vec2(i);
  float a = fetchC(i), b = fetchC(i + ivec2(1, 0)), c = fetchC(i + ivec2(0, 1)), d = fetchC(i + ivec2(1, 1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

vec3 ramp(float t, vec3 a, vec3 b) { return mix(a, b, clamp(t, 0.0, 1.0)); }

vec3 hypsometric(float h) {
  if (h < 0.0) {
    float d = clamp(-h / 5000.0, 0.0, 1.0);
    return mix(vec3(0.33, 0.62, 0.74), vec3(0.04, 0.12, 0.27), pow(d, 0.45));
  }
  if (h < 400.0)  return ramp(h / 400.0, vec3(0.36, 0.55, 0.33), vec3(0.55, 0.64, 0.38));
  if (h < 1200.0) return ramp((h - 400.0) / 800.0, vec3(0.55, 0.64, 0.38), vec3(0.78, 0.70, 0.47));
  if (h < 2500.0) return ramp((h - 1200.0) / 1300.0, vec3(0.78, 0.70, 0.47), vec3(0.56, 0.44, 0.34));
  if (h < 4000.0) return ramp((h - 2500.0) / 1500.0, vec3(0.56, 0.44, 0.34), vec3(0.75, 0.73, 0.72));
  return ramp((h - 4000.0) / 2000.0, vec3(0.75, 0.73, 0.72), vec3(0.97, 0.97, 0.98));
}

vec3 categorical(float id) {
  float h = fract(id * 0.61803398875 + 0.13);
  vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return mix(vec3(0.5), k, 0.55) * 0.85 + 0.08;
}

vec3 viridis(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec3 c0 = vec3(0.2777, 0.0054, 0.3341), c1 = vec3(0.1050, 1.4046, 1.3846), c2 = vec3(-0.3309, 0.2148, 0.0951);
  const vec3 c3 = vec3(-4.6342, -5.7991, -19.3324), c4 = vec3(6.2283, 14.1799, 56.6906), c5 = vec3(4.7764, -13.7451, -65.3530);
  const vec3 c6 = vec3(-5.4355, 4.6459, 26.3124);
  return c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6)))));
}

void main() {
  vec2 p = v_uv * vec2(u_size);
  if (u_mode == 1) {
    o = vec4(categorical(floor(fetchC(ivec2(floor(p))) + 0.5)), 1.0);
    return;
  }
  float h = heightAt(p);
  if (u_mode == 2) {
    o = vec4(viridis((h - u_min) / max(1e-6, u_max - u_min)), 1.0);
    return;
  }
  // Elevation: hypsometric tint + north-west hillshade (light from the top-left of the map).
  float e = 0.5;
  float dx = (heightAt(p + vec2(e, 0.0)) - heightAt(p - vec2(e, 0.0))) / (2.0 * e * u_cellM);
  float dy = (heightAt(p + vec2(0.0, e)) - heightAt(p - vec2(0.0, e))) / (2.0 * e * u_cellM);
  vec3 n = normalize(vec3(-dx * u_exag, -dy * u_exag, 1.0));
  vec3 L = normalize(vec3(-0.6, -0.6, 0.75));
  float shade = clamp(dot(n, L) / L.z, 0.0, 1.6);
  vec3 c = hypsometric(h);
  float k = h < 0.0 ? 0.25 : 0.85;
  c *= mix(1.0, 0.35 + 0.65 * shade, k);
  // Thin coastline.
  float w = fwidth(h);
  c = mix(c, vec3(0.05, 0.09, 0.14), (1.0 - smoothstep(0.0, 1.5 * w, abs(h))) * 0.6);
  o = vec4(c, 1.0);
}`;

const MODE: Record<LayerKind, number> = { elevation: 0, categorical: 1, scalar: 2 };

/** WebGL2 debug view of one raster layer over the whole world (M0). */
export class RasterView {
  private readonly gl: WebGL2RenderingContext;
  private readonly prog: WebGLProgram;
  private readonly u;
  private readonly vao: WebGLVertexArrayObject;
  private readonly tex: WebGLTexture;
  private layer: Layer | null = null;
  private readonly view = new Float32Array(9);
  exaggeration = 12;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.prog = compileProgram(gl, 'raster', VS, FS);
    this.u = uniforms(gl, this.prog, ['u_view', 'u_worldKm', 'u_tex', 'u_size', 'u_mode', 'u_min', 'u_max', 'u_cellM', 'u_exag'] as const);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  setLayer(layer: Layer): void {
    const gl = this.gl;
    const data = layer.data instanceof Float32Array ? layer.data : Float32Array.from(layer.data);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, layer.w, layer.h, 0, gl.RED, gl.FLOAT, data);
    this.layer = layer;
  }

  /** Resizes the drawing buffer to the canvas's CSS size × DPR. */
  resize(cam: Camera): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    cam.viewW = w;
    cam.viewH = h;
    cam.dpr = dpr;
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
  }

  draw(cam: Camera): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.035, 0.04, 0.05, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const l = this.layer;
    if (!l) return;
    gl.useProgram(this.prog);
    gl.uniformMatrix3fv(this.u.u_view, false, cam.viewMatrix(this.view));
    gl.uniform1f(this.u.u_worldKm, l.worldKm);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.u.u_tex, 0);
    gl.uniform2i(this.u.u_size, l.w, l.h);
    gl.uniform1i(this.u.u_mode, MODE[l.kind]);
    gl.uniform1f(this.u.u_min, l.min);
    gl.uniform1f(this.u.u_max, l.max);
    gl.uniform1f(this.u.u_cellM, (l.worldKm * 1000) / l.w);
    gl.uniform1f(this.u.u_exag, this.exaggeration);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }
}

/** Value of `layer` at world position (km), or null outside the world. */
export function sampleLayer(layer: Layer, xKm: number, yKm: number): number | null {
  const x = Math.floor((xKm / layer.worldKm) * layer.w);
  const y = Math.floor((yKm / layer.worldKm) * layer.h);
  if (x < 0 || y < 0 || x >= layer.w || y >= layer.h) return null;
  return layer.data[y * layer.w + x];
}
