import { compileProgram, createQuadBuffer, uniforms } from '../gl/util';

const VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/**
 * Horizon-angle lighting (research 04 §3): for every texel of the surface raster, march toward the
 * sun and record how far the sun's elevation clears the highest horizon (soft shadows with a
 * penumbra), and average horizon angles over 8 directions for ambient occlusion. No shadow maps:
 * a top-down camera over 1000 km would waste their resolution.
 */
const FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 v_uv;
uniform sampler2D u_surface;   // R32F rendered surface (m), row 0 = north
uniform int u_n;
uniform float u_cell;          // m
uniform float u_exag;
uniform vec3 u_sun;            // unit vector toward the sun (world: x east, y north, z up)
uniform int u_doAO;
out vec4 o;

float hAt(vec2 p) {            // p in texel units (x east, y = row south)
  vec2 q = p - 0.5;
  ivec2 i = ivec2(floor(q));
  vec2 f = q - vec2(i);
  ivec2 mx = ivec2(u_n - 1);
  float a = texelFetch(u_surface, clamp(i, ivec2(0), mx), 0).r;
  float b = texelFetch(u_surface, clamp(i + ivec2(1, 0), ivec2(0), mx), 0).r;
  float c = texelFetch(u_surface, clamp(i + ivec2(0, 1), ivec2(0), mx), 0).r;
  float d = texelFetch(u_surface, clamp(i + ivec2(1, 1), ivec2(0), mx), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * u_exag;
}

// Tangent of the highest horizon along texel-space direction dir (|dir| = 1), doubling step sizes.
float horizonTan(vec2 p, vec2 dir, float h0) {
  float best = -1e9;
  float t = 0.75;
  for (int k = 0; k < 40; k++) {
    vec2 q = p + dir * t;
    if (q.x < 0.0 || q.y < 0.0 || q.x > float(u_n) || q.y > float(u_n)) break;
    best = max(best, (hAt(q) - h0) / (t * u_cell));
    t *= 1.16;
  }
  return best;
}

void main() {
  vec2 p = v_uv * float(u_n);
  float h0 = hAt(p);
  // Texel space has y pointing south, world y points north.
  vec2 sunDir = normalize(vec2(u_sun.x, -u_sun.y));
  float sunTan = u_sun.z / max(1e-4, length(u_sun.xy));
  float hor = horizonTan(p, sunDir, h0);
  // Soft penumbra: the sun's disc plus some atmospheric softness (~2.5°).
  float vis = smoothstep(-0.045, 0.045, atan(sunTan) - atan(hor));
  float ao = 1.0;
  if (u_doAO == 1) {
    float occl = 0.0;
    for (int k = 0; k < 8; k++) {
      float a = float(k) * 0.7853982 + 0.3;
      float ht = max(0.0, horizonTan(p, vec2(cos(a), sin(a)), h0));
      occl += sin(atan(ht));
    }
    ao = 1.0 - occl / 8.0;
  }
  o = vec4(vis, ao, 0.0, 1.0);
}`;

/** Sun-visibility texture (r) and ambient-occlusion texture (g) over the surface raster. */
export class HorizonPass {
  private readonly prog: WebGLProgram;
  private readonly u;
  private readonly quad: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly surfaceTex: WebGLTexture;
  /** r = sun visibility (0 shadow … 1 lit). */
  readonly texture: WebGLTexture;
  /** g = ambient occlusion (1 open … 0 enclosed). */
  readonly aoTexture: WebGLTexture;
  private readonly fbo: WebGLFramebuffer;
  private n = 0;
  private cell = 1;
  private lastKey = '';
  private aoKey = '';
  ready = false;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.prog = compileProgram(gl, 'horizon', VS, FS);
    this.u = uniforms(gl, this.prog, ['u_surface', 'u_n', 'u_cell', 'u_exag', 'u_sun', 'u_doAO'] as const);
    this.quad = createQuadBuffer(gl);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.surfaceTex = gl.createTexture();
    this.texture = makeTarget(gl);
    this.aoTexture = makeTarget(gl);
    this.fbo = gl.createFramebuffer();
  }

  /** New terrain: the rendered surface (water lid applied), metres, n×n, row 0 = north. */
  setSurface(surface: Float32Array, n: number, worldM: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.surfaceTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, n, n, 0, gl.RED, gl.FLOAT, surface);
    for (const t of [this.texture, this.aoTexture]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    this.n = n;
    this.cell = worldM / n;
    this.lastKey = '';
    this.aoKey = '';
    this.ready = false;
  }

  /**
   * Recomputes sun visibility when the sun direction or exaggeration changed noticeably (cheap enough
   * to follow camera rotation, since map lighting keeps the sun at the top-left of the screen).
   * AO is computed once per terrain and exaggeration and carried in the g channel.
   */
  update(sun: readonly [number, number, number], exag: number): void {
    if (this.n === 0) return;
    const az = Math.round((Math.atan2(sun[0], sun[1]) * 180) / Math.PI / 1.5);
    const key = `${az}|${Math.round(sun[2] * 100)}|${exag}`;
    if (key === this.lastKey) return;
    const gl = this.gl;
    const aoKey = String(exag);
    const needAO = aoKey !== this.aoKey;
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.surfaceTex);
    gl.uniform1i(this.u.u_surface, 0);
    gl.uniform1i(this.u.u_n, this.n);
    gl.uniform1f(this.u.u_cell, this.cell);
    gl.uniform1f(this.u.u_exag, exag);
    gl.uniform3f(this.u.u_sun, sun[0], sun[1], sun[2]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.n, this.n);
    gl.bindVertexArray(this.vao);
    if (needAO) {
      gl.uniform1i(this.u.u_doAO, 1);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.aoTexture, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this.aoKey = aoKey;
    }
    gl.uniform1i(this.u.u_doAO, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.lastKey = key;
    this.ready = true;
  }
}

function makeTarget(gl: WebGL2RenderingContext): WebGLTexture {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  return t;
}
