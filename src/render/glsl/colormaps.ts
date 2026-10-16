/** Colour ramps shared by the 2D raster view and the 3D terrain (GLSL source). */
export const COLORMAPS_GLSL = /* glsl */ `
vec3 ramp(float t, vec3 a, vec3 b) { return mix(a, b, clamp(t, 0.0, 1.0)); }

// Hypsometric tint: green lowlands, tan uplands, grey rock, white summits. Ocean by depth.
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
}`;
