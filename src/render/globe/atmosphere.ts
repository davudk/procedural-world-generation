import { compileProgram, createQuadBuffer, uniforms } from '../gl/util';
import { invert, mat4 } from '../math/mat4';

/**
 * Atmosphere of a globe (research 10 §6.6): single Rayleigh scattering through a shell above the sea
 * sphere, integrated along each view ray in a few steps. From space it is the blue limb glow with a
 * day/night terminator; from inside it becomes the sky and, along low tilted views, the aerial haze
 * over the terrain (the terrain shader calls the same function for its fragments).
 *
 * Paste GLOBE_ATMOS_GLSL after `precision` declarations. Provides
 *   vec3 atmosphere(vec3 ro, vec3 rd, float tMax, int steps, out vec3 trans)   in-scattered light and
 * transmittance for a ray from planet-centred `ro` (m) along unit `rd`, up to distance tMax, and
 * atmosphereK with the scattering scaled by k. Terrain and rivers use TERRAIN_AIR_K: the stylised
 * air's path radiance is several times Earth's, which washed the land out to grey at regional zoom,
 * while long slant paths (low tilted views, the limb) still saturate to the sky colour.
 */
export const GLOBE_ATMOS_GLSL = /* glsl */ `
uniform vec3 u_eyeP;        // eye, planet-centred (m)
uniform float u_planetR;    // sea-level radius (m)
uniform float u_atmTop;     // radius of the top of the atmosphere (m)
uniform float u_atmH;       // density scale height (m)
uniform vec3 u_beta;        // Rayleigh scattering coefficients at sea level (1/m)
uniform vec3 u_atmSun;      // unit vector toward the light that lights the air
uniform float u_atmSunI;    // its intensity (0 = no light)

vec3 atmosphereK(vec3 ro, vec3 rd, float tMax, int steps, float k, out vec3 trans) {
  vec3 beta = u_beta * k;
  trans = vec3(1.0);
  float b = dot(ro, rd);
  float c = dot(ro, ro) - u_atmTop * u_atmTop;
  float disc = b * b - c;
  if (disc <= 0.0) return vec3(0.0);
  float s = sqrt(disc);
  float t0 = max(0.0, -b - s);
  float t1 = min(tMax, -b + s);
  if (t1 <= t0) return vec3(0.0);
  float ds = (t1 - t0) / float(steps);
  vec3 tau = vec3(0.0);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    if (i >= steps) break;
    vec3 p = ro + rd * (t0 + (float(i) + 0.5) * ds);
    float r = length(p);
    float rho = exp(-max(0.0, r - u_planetR) / u_atmH);
    vec3 dTau = beta * rho * ds;
    float mu = dot(p / r, u_atmSun);
    // Light reaching the sample: Chapman-like optical depth toward the sun, cut by the planet's shadow
    // (soft over the few degrees the sun takes to set at that height).
    float dip = acos(clamp(u_planetR / r, 0.0, 1.0));
    float lit = smoothstep(-dip - 0.06, -dip + 0.04, mu);
    vec3 tauSun = beta * u_atmH * rho / max(0.06, mu + 0.12);
    sum += exp(-(tau + 0.5 * dTau) - tauSun) * rho * ds * lit;
    tau += dTau;
  }
  trans = exp(-tau);
  float cs = dot(rd, u_atmSun);
  float phase = 0.75 * (1.0 + cs * cs);
  // Rayleigh plus a little forward glow and grey multiple-scattering fill, so skies read light blue.
  vec3 ray = sum * beta * phase;
  vec3 fill = sum * dot(beta, vec3(0.33)) * 0.35;
  float mie = 0.04 * pow(max(cs, 0.0), 8.0);
  return (ray + fill + mie * sum * beta.b) * u_atmSunI;
}
// The sky and the limb: the full air.
vec3 atmosphere(vec3 ro, vec3 rd, float tMax, int steps, out vec3 trans) {
  return atmosphereK(ro, rd, tMax, steps, 1.0, trans);
}
`;

/**
 * Tone curve of the globe terrain and rivers (fragment shaders): identity up to 0.8, the flat
 * terrain's response, so biome colours keep their saturation, then a soft shoulder to 1 for bright
 * snow, ice and glare. The sky pass keeps 1 − exp(−1.2 c), which the limb glow needs.
 */
export const TERRAIN_TONE_GLSL = /* glsl */ `
vec3 terrainTone(vec3 c) {
  return min(c, vec3(0.8)) + 0.2 * (1.0 - exp(-max(c - 0.8, vec3(0.0)) / 0.2));
}
`;

/** Scattering scale of the aerial perspective over terrain and rivers (see GLOBE_ATMOS_GLSL). */
export const TERRAIN_AIR_K = 0.25;

/** Atmosphere constants for a planet of radius R (m): a stylised shell of 2.5 % R. */
export function atmosphereFor(R: number): { top: number; H: number; beta: [number, number, number] } {
  const top = R * 1.025;
  // Scale height a quarter of the shell; the vertical optical depth matches Earth's (0.05, 0.11, 0.27).
  const H = (top - R) * 0.25;
  return { top, H, beta: [0.05 / H, 0.11 / H, 0.27 / H] };
}

const VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_ndc;
void main() {
  v_ndc = a_pos;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_ndc;
uniform mat4 u_invViewProj;   // camera-relative (eye at the origin)
uniform float u_nearZ;
uniform vec3 u_sunDisc;       // unit vector toward the real sun (sun disc)
${GLOBE_ATMOS_GLSL}
out vec4 o;

float starHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  vec4 a = u_invViewProj * vec4(v_ndc, u_nearZ, 1.0);
  vec4 b = u_invViewProj * vec4(v_ndc, 0.5, 1.0);
  vec3 rd = normalize(b.xyz / b.w - a.xyz / a.w);
  vec3 ro = u_eyeP;
  // Up to the sea sphere: behind the planet the terrain pass draws over this.
  float tb = dot(ro, rd);
  float tc = dot(ro, ro) - u_planetR * u_planetR;
  float disc = tb * tb - tc;
  float tMax = 1e30;
  bool hit = disc > 0.0 && -tb - sqrt(disc) > 0.0;
  if (hit) tMax = -tb - sqrt(disc);
  vec3 trans;
  vec3 sky = atmosphere(ro, rd, tMax, 12, trans);
  // Space: near black with a sparse star field, dimmed behind the air.
  vec3 space = vec3(0.004, 0.006, 0.012);
  vec3 cell = floor(rd * 1400.0);
  float st = starHash(cell);
  if (st > 0.9992) space += vec3(0.6) * (st - 0.9992) / 0.0008;
  vec3 col = hit ? sky : space * trans + sky;
  // The sun's disc and a soft glow around it.
  float cs = max(dot(rd, u_sunDisc), 0.0);
  if (!hit) col += trans * (vec3(1.0, 0.95, 0.85) * smoothstep(0.99995, 0.99999, cs) * 6.0 + vec3(1.0, 0.9, 0.7) * 0.25 * pow(cs, 400.0));
  // Simple tone map (the scattering can exceed 1 at the limb).
  col = 1.0 - exp(-col * 1.2);
  o = vec4(pow(col, vec3(1.0 / 1.1)), 1.0);
}`;

/** Per-frame atmosphere uniforms, shared by the background pass and the globe terrain. */
export interface GlobeAtmosFrame {
  eye: { x: number; y: number; z: number };
  radius: number;
  /** Light for the air (real sun, or the cartographic light in data map modes) and its intensity. */
  sun: readonly [number, number, number];
  sunI: number;
}

const NAMES = ['u_eyeP', 'u_planetR', 'u_atmTop', 'u_atmH', 'u_beta', 'u_atmSun', 'u_atmSunI'] as const;
type Locs = Record<(typeof NAMES)[number], WebGLUniformLocation | null>;
const cache = new WeakMap<WebGLProgram, Locs>();

/** Binds GLOBE_ATMOS_GLSL's uniforms (after gl.useProgram(prog)). */
export function bindGlobeAtmos(gl: WebGL2RenderingContext, prog: WebGLProgram, f: GlobeAtmosFrame): void {
  let u = cache.get(prog);
  if (!u) {
    u = {} as Locs;
    for (const n of NAMES) u[n] = gl.getUniformLocation(prog, n);
    cache.set(prog, u);
  }
  const a = atmosphereFor(f.radius);
  gl.uniform3f(u.u_eyeP, f.eye.x, f.eye.y, f.eye.z);
  gl.uniform1f(u.u_planetR, f.radius);
  gl.uniform1f(u.u_atmTop, a.top);
  gl.uniform1f(u.u_atmH, a.H);
  gl.uniform3f(u.u_beta, a.beta[0], a.beta[1], a.beta[2]);
  gl.uniform3f(u.u_atmSun, f.sun[0], f.sun[1], f.sun[2]);
  gl.uniform1f(u.u_atmSunI, f.sunI);
}

/** Full-screen pass: space, stars, the sun and the atmosphere (drawn before the globe terrain). */
export class GlobeSkyPass {
  private readonly prog: WebGLProgram;
  private readonly u;
  private readonly vao: WebGLVertexArrayObject;
  private readonly inv = mat4();
  private readonly inv32 = new Float32Array(16);

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.prog = compileProgram(gl, 'globe-sky', VS, FS);
    this.u = uniforms(gl, this.prog, ['u_invViewProj', 'u_nearZ', 'u_sunDisc'] as const);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, createQuadBuffer(gl));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  draw(viewProj: Float32Array, reversedZ: boolean, atmos: GlobeAtmosFrame, sunDisc: readonly [number, number, number]): void {
    if (!invert(this.inv, viewProj)) return;
    this.inv32.set(this.inv);
    const gl = this.gl;
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.u_invViewProj, false, this.inv32);
    gl.uniform1f(this.u.u_nearZ, reversedZ ? 1 : -1);
    gl.uniform3f(this.u.u_sunDisc, sunDisc[0], sunDisc[1], sunDisc[2]);
    bindGlobeAtmos(gl, this.prog, atmos);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }
}
