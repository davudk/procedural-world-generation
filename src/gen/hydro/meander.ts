/**
 * Sine-generated / Kinoshita meanders (Langbein & Leopold 1966; research 02 §4.2): direction relative
 * to the valley axis θ(s) = θ0·sin φ + θ0³·(Js·cos 3φ − Jf·sin 3φ), φ = 2πs/λ along the channel.
 */

export const KINOSHITA_JS = 0.03;
export const KINOSHITA_JF = 0.005;
/** Largest deflection used (rad, ≈ 115°): beyond ~125° the curve self-intersects. */
export const THETA_MAX = 2.0;
/** Leopold–Wolman threshold slope coefficient: S_t = κ·Q^−0.44. */
export const MEANDER_KAPPA = 0.01;

const STEPS = 200;
const sigmaTab = new Float64Array(STEPS + 1);
/** Half-amplitude across the valley over the valley wavelength. */
const ampTab = new Float64Array(STEPS + 1);

function besselJ0(x: number): number {
  let term = 1;
  let sum = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 30; k++) {
    term *= -q / (k * k);
    sum += term;
  }
  return sum;
}

for (let i = 0; i <= STEPS; i++) {
  const th = (i / STEPS) * THETA_MAX;
  const sigma = 1 / besselJ0(th);
  sigmaTab[i] = sigma;
  // Lateral excursion over half a channel wavelength (λ_s = 1); centred half-amplitude is half of it.
  const m = 400;
  let y = 0;
  for (let k = 0; k < m; k++) y += Math.sin(th * Math.sin(Math.PI * ((k + 0.5) / m))) * (0.5 / m);
  ampTab[i] = (y / 2) * sigma;
}

const thetaAt = (i: number): number => (i / STEPS) * THETA_MAX;

/** Sinuosity of the sine-generated curve, 1/J0(θ0). */
export function sinuosity(theta0: number): number {
  const t = Math.min(STEPS, Math.max(0, (theta0 / THETA_MAX) * STEPS));
  const i = Math.min(STEPS - 1, Math.floor(t));
  return sigmaTab[i] + (sigmaTab[i + 1] - sigmaTab[i]) * (t - i);
}

function invert(tab: Float64Array, v: number): number {
  if (v <= tab[0]) return 0;
  if (v >= tab[STEPS]) return THETA_MAX;
  let a = 0;
  let b = STEPS;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (tab[m] <= v) a = m;
    else b = m;
  }
  return thetaAt(a) + ((v - tab[a]) / (tab[b] - tab[a])) * (thetaAt(b) - thetaAt(a));
}

/** θ0 giving sinuosity σ. */
export function thetaForSinuosity(sigma: number): number {
  return invert(sigmaTab, sigma);
}

/** Largest θ0 whose half-amplitude stays within `amp` for valley wavelength `lambdaV`. */
export function thetaForAmplitude(amp: number, lambdaV: number): number {
  return invert(ampTab, amp / lambdaV);
}

/** Below this discharge (m³/s) meanders are sub-node detail and fade out of the macro graph. */
const MEANDER_Q0 = 0.5;
const MEANDER_Q1 = 10;

/**
 * Target sinuosity from slope and discharge (Leopold & Wolman threshold, research 02 §4.2). Small
 * streams, whose real meanders are far below the node spacing, are kept straight.
 */
export function targetSinuosity(slope: number, q: number, sigmaMax: number): number {
  if (sigmaMax <= 1 || q <= MEANDER_Q0) return 1;
  const st = MEANDER_KAPPA * Math.pow(q, -0.44);
  const t = Math.min(1, Math.max(0, (st - slope) / (st - st / 10)));
  const u = Math.min(1, (q - MEANDER_Q0) / (MEANDER_Q1 - MEANDER_Q0));
  return 1 + (sigmaMax - 1) * t * t * (3 - 2 * t) * u * u * (3 - 2 * u);
}

/** Channel direction (rad) relative to the valley axis at phase φ. */
export function kinoshita(theta0: number, phi: number): number {
  const t3 = theta0 * theta0 * theta0;
  return theta0 * Math.sin(phi) + t3 * (KINOSHITA_JS * Math.cos(3 * phi) - KINOSHITA_JF * Math.sin(3 * phi));
}
