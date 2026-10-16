/**
 * Clouds, cloud shadows and valley fog (M9), shared by the terrain, river and cloud passes.
 *
 * Paste ATMOS_GLSL into a fragment shader after declaring `u_size` (world size, m), `u_sun` (unit
 * vector toward the light) and `u_hazeColor`. Provides:
 *   float cloudDensity(vec2 w, float foot)            0..1 cloud at world xy (m), octaves faded by footprint
 *   float cloudShadow(vec2 w, float z, float foot)    direct-light factor under the clouds (z = render height)
 *   float valleyFog(vec2 w, float pot, float humid, float foot)   fog opacity
 *   vec3  fogColor()                                  lit fog colour
 * The cloud field is a drifting fBm thresholded by a climate cloudiness map (wet and high ground
 * cloudier, deserts nearly clear). Valley fog uses a fog potential baked by the horizon pass
 * (low relative to the surroundings, with relief around) times humidity, strongest at low sun.
 */
export const ATMOS_GLSL = /* glsl */ `
uniform sampler2D u_clim2;    // RGBA8 linear: r seasonal half-range T/30 °C, g cloudiness/humidity, b deciduous, a conifer
uniform float u_cloudAmount;  // 0 = clouds off
uniform vec2 u_cloudDrift;    // wind drift of the cloud field (m)
uniform float u_cloudZ;       // cloud base in render space (m, exaggerated)
uniform float u_fogK;         // valley-fog strength from the sun and the season (0 at the default)
uniform vec3 u_lightCol;      // direct light colour × intensity (1 at the default)
uniform vec3 u_ambient;       // ambient light multiplier (1 at the default)

float atHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float atNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(atHash(i), atHash(i + vec2(1, 0)), u.x), mix(atHash(i + vec2(0, 1)), atHash(i + 1.0), u.x), u.y);
}

float cloudDensity(vec2 w, float foot) {
  float cover = u_cloudAmount * texture(u_clim2, vec2(w.x, u_size - w.y) / u_size).g;
  if (cover < 0.01) return 0.0;
  vec2 p = w + u_cloudDrift;
  // Weather systems (~100 km) modulate the cover; cumulus-scale octaves fade out below ~4 px.
  float big = atNoise(p / 110000.0 + 3.1);
  float n = 0.45 * atNoise(p / 9000.0);
  float amp = 0.3;
  float lam = 3400.0;
  for (int k = 0; k < 3; k++) {
    float f = 1.0 - smoothstep(lam * 0.25, lam * 0.5, foot);
    n += amp * mix(0.5, atNoise(p / lam + float(k) * 7.31), f);
    amp *= 0.55;
    lam *= 0.38;
  }
  float c = clamp(cover * (0.3 + 1.2 * big), 0.0, 1.0);
  float t = 1.0 - c;
  return smoothstep(t - 0.05, t + 0.3, n) * smoothstep(0.02, 0.2, c);
}

// The cloud above a surface point along the light direction; soft (low octaves only).
float cloudShadow(vec2 w, float z, float foot) {
  if (u_cloudAmount <= 0.0 || z >= u_cloudZ) return 1.0;
  vec2 q = w + u_sun.xy / max(u_sun.z, 0.15) * (u_cloudZ - z);
  return 1.0 - 0.6 * cloudDensity(q, max(foot, 400.0));
}

float valleyFog(vec2 w, float pot, float humid, float foot) {
  if (u_fogK <= 0.0 || pot <= 0.004) return 0.0;
  float fine = 1.0 - smoothstep(250.0, 500.0, foot);
  float n = 0.65 * atNoise((w + 0.25 * u_cloudDrift) / 3500.0) + 0.35 * mix(0.5, atNoise(w / 1000.0 + 5.3), fine);
  return smoothstep(0.2, 0.85, pot * (0.4 + 0.9 * humid) + 0.45 * (n - 0.5)) * u_fogK;
}

vec3 fogColor() {
  return mix(u_hazeColor, vec3(0.92, 0.93, 0.95), 0.6) * min(vec3(1.0), 0.75 * u_ambient + 0.35 * u_lightCol);
}
`;

/** Per-frame atmosphere state. */
export interface AtmosFrame {
  /** Climate texture for clouds and seasons (see TerrainPass.climate2). */
  clim2: WebGLTexture;
  cloudAmount: number;
  cloudDrift: readonly [number, number];
  cloudZ: number;
  fogK: number;
  light: readonly [number, number, number];
  ambient: readonly [number, number, number];
}

const NAMES = ['u_clim2', 'u_cloudAmount', 'u_cloudDrift', 'u_cloudZ', 'u_fogK', 'u_lightCol', 'u_ambient'] as const;
type Locs = Record<(typeof NAMES)[number], WebGLUniformLocation | null>;
const cache = new WeakMap<WebGLProgram, Locs>();

/** Binds ATMOS_GLSL's uniforms (call after gl.useProgram(prog)); the climate texture goes on `unit`. */
export function bindAtmos(gl: WebGL2RenderingContext, prog: WebGLProgram, f: AtmosFrame, unit: number): void {
  let u = cache.get(prog);
  if (!u) {
    u = {} as Locs;
    for (const n of NAMES) u[n] = gl.getUniformLocation(prog, n);
    cache.set(prog, u);
  }
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, f.clim2);
  gl.uniform1i(u.u_clim2, unit);
  gl.uniform1f(u.u_cloudAmount, f.cloudAmount);
  gl.uniform2f(u.u_cloudDrift, f.cloudDrift[0], f.cloudDrift[1]);
  gl.uniform1f(u.u_cloudZ, f.cloudZ);
  gl.uniform1f(u.u_fogK, f.fogK);
  gl.uniform3f(u.u_lightCol, f.light[0], f.light[1], f.light[2]);
  gl.uniform3f(u.u_ambient, f.ambient[0], f.ambient[1], f.ambient[2]);
}
