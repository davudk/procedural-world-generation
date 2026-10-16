import { compileProgram, createQuadBuffer, uniforms } from '../gl/util';
import { invert, mat4 } from '../math/mat4';

const VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_ndc;
void main() {
  v_ndc = a_pos;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

/** Analytic gradient sky (research 04 §3): horizon matches the haze colour, so tilted terrain fades into it. */
const FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_ndc;
uniform mat4 u_invViewProj;
uniform vec3 u_horizon;
uniform vec3 u_zenith;
uniform vec3 u_sun;
uniform vec3 u_glow;     // sun glow colour × strength (0 at night)
uniform float u_nearZ;   // NDC depth of the near plane: 1 with reversed-Z, −1 otherwise
out vec4 o;
void main() {
  vec4 a = u_invViewProj * vec4(v_ndc, u_nearZ, 1.0);
  vec4 b = u_invViewProj * vec4(v_ndc, 0.5, 1.0);
  vec3 d = normalize(b.xyz / b.w - a.xyz / a.w);
  float up = d.z;
  vec3 c = mix(u_horizon, u_zenith, smoothstep(0.0, 0.45, up));
  c = mix(c, u_horizon * 0.3, smoothstep(0.0, -0.25, up));   // below the horizon: beyond the world edge
  c += u_glow * pow(max(dot(d, u_sun), 0.0), 64.0);
  o = vec4(pow(c, vec3(1.0 / 1.1)), 1.0);
}`;

export class SkyPass {
  private readonly prog: WebGLProgram;
  private readonly u;
  private readonly vao: WebGLVertexArrayObject;
  private readonly inv = mat4();
  private readonly inv32 = new Float32Array(16);

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.prog = compileProgram(gl, 'sky', VS, FS);
    this.u = uniforms(gl, this.prog, ['u_invViewProj', 'u_horizon', 'u_zenith', 'u_sun', 'u_glow', 'u_nearZ'] as const);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, createQuadBuffer(gl));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  /** Colours come from the sun model (lighting/sun.ts); its defaults are the pre-M9 constants. */
  draw(
    viewProj: Float32Array,
    sky: { horizon: readonly [number, number, number]; zenith: readonly [number, number, number]; glow: readonly [number, number, number] },
    sun: readonly [number, number, number],
    reversedZ: boolean,
  ): void {
    if (!invert(this.inv, viewProj)) return;
    this.inv32.set(this.inv);
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.u_invViewProj, false, this.inv32);
    gl.uniform3f(this.u.u_horizon, sky.horizon[0], sky.horizon[1], sky.horizon[2]);
    gl.uniform3f(this.u.u_zenith, sky.zenith[0], sky.zenith[1], sky.zenith[2]);
    gl.uniform3f(this.u.u_glow, sky.glow[0], sky.glow[1], sky.glow[2]);
    gl.uniform3f(this.u.u_sun, sun[0], sun[1], sun[2]);
    gl.uniform1f(this.u.u_nearZ, reversedZ ? 1 : -1);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }
}
