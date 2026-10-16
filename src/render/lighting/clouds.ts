import { compileProgram, createQuadBuffer, uniforms } from '../gl/util';
import { ATMOS_GLSL, bindAtmos, type AtmosFrame } from './atmosphere';

const VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
uniform mat4 u_viewProj;
uniform vec3 u_origin;
uniform float u_extent;
uniform float u_cloudZ;
out vec3 v_rel;
void main() {
  // A horizontal sheet at the cloud base, centred under the camera (camera-relative coordinates).
  v_rel = vec3(a_pos * u_extent, u_cloudZ - u_origin.z);
  gl_Position = u_viewProj * vec4(v_rel, 1.0);
}`;

/** Visible clouds: a thin, partly transparent sheet, lit from the sun with a cheap self-shading term. */
const FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec3 v_rel;
uniform vec3 u_origin;
uniform float u_size;
uniform vec3 u_sun;
uniform vec3 u_hazeColor;
uniform float u_haze;
uniform float u_alpha;
${ATMOS_GLSL}
out vec4 o;
void main() {
  vec2 w = v_rel.xy + u_origin.xy;
  float foot = length(fwidth(w));
  float edge = min(min(w.x, w.y), min(u_size - w.x, u_size - w.y));
  float d = cloudDensity(w, foot) * smoothstep(-40000.0, 0.0, edge);
  if (d < 0.01) discard;
  // Thinner cloud toward the sun means this is the sunlit flank.
  vec2 sd = u_sun.xy / max(1e-3, length(u_sun.xy));
  float toward = cloudDensity(w + sd * 1800.0, max(foot, 700.0));
  float lit = clamp(0.75 + 1.2 * (d - toward), 0.35, 1.0);
  // Thick cores read brighter (tops in the sun), thin edges greyer and more transparent.
  vec3 col = (0.82 + 0.18 * d) * (u_lightCol * (0.5 + 0.38 * lit) + u_ambient * vec3(0.55, 0.60, 0.68) * 0.32);
  col = mix(col, u_hazeColor, 1.0 - exp(-length(v_rel) * u_haze));
  o = vec4(pow(col, vec3(1.0 / 1.1)), d * d * (3.0 - 2.0 * d) * u_alpha);
}`;

export interface CloudFrame {
  viewProj: Float32Array;
  origin: { x: number; y: number; z: number };
  worldSize: number;
  sun: readonly [number, number, number];
  haze: number;
  hazeColor: readonly [number, number, number];
  /** Overall sheet opacity (0 skips the pass). */
  alpha: number;
  atmos: AtmosFrame;
}

/** Draws the cloud sheet after the opaque terrain and rivers; mountains above the base occlude it. */
export class CloudPass {
  private readonly prog: WebGLProgram;
  private readonly u;
  private readonly vao: WebGLVertexArrayObject;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.prog = compileProgram(gl, 'clouds', VS, FS);
    this.u = uniforms(gl, this.prog, ['u_viewProj', 'u_origin', 'u_extent', 'u_cloudZ', 'u_size', 'u_sun', 'u_hazeColor', 'u_haze', 'u_alpha'] as const);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, createQuadBuffer(gl));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  draw(f: CloudFrame): void {
    if (f.alpha <= 0 || f.atmos.cloudAmount <= 0 || f.origin.z <= f.atmos.cloudZ) return;
    const gl = this.gl;
    gl.useProgram(this.prog);
    const centre = Math.hypot(f.origin.x - f.worldSize / 2, f.origin.y - f.worldSize / 2);
    gl.uniformMatrix4fv(this.u.u_viewProj, false, f.viewProj);
    gl.uniform3f(this.u.u_origin, f.origin.x, f.origin.y, f.origin.z);
    gl.uniform1f(this.u.u_extent, f.worldSize * 0.75 + centre + 50e3);
    gl.uniform1f(this.u.u_cloudZ, f.atmos.cloudZ);
    gl.uniform1f(this.u.u_size, f.worldSize);
    gl.uniform3f(this.u.u_sun, f.sun[0], f.sun[1], f.sun[2]);
    gl.uniform3f(this.u.u_hazeColor, f.hazeColor[0], f.hazeColor[1], f.hazeColor[2]);
    gl.uniform1f(this.u.u_haze, f.haze);
    gl.uniform1f(this.u.u_alpha, f.alpha);
    bindAtmos(gl, this.prog, f.atmos, 0);
    gl.enable(gl.BLEND);
    // Keep destination alpha at 1: the canvas is not premultiplied, so lower alpha would show the page.
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.depthMask(false);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
}
