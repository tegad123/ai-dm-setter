/**
 * Generate a human-like response delay using a log-normal distribution.
 *
 * Uniform random (`Math.random() * range`) creates a detectable fingerprint
 * at the account level — Meta's behavioral detection can flag consistent
 * patterns where every short message takes ~90s and every long one ~4min.
 *
 * Log-normal naturally skews toward shorter delays with occasional longer
 * ones, matching real human typing behavior (most replies are fast, some
 * take a while when the person is distracted or multitasking).
 *
 * Uses Box-Muller transform to generate normally-distributed values,
 * then exponentiates to get log-normal. Result is clamped to [min, max].
 */
export function humanResponseDelay(minSec: number, maxSec: number): number {
  if (minSec >= maxSec) return minSec;

  // Center the log-normal around the geometric mean of the range
  const mu = Math.log(Math.sqrt(minSec * maxSec) || (minSec + maxSec) / 2);
  const sigma = 0.5;

  // Box-Muller transform: two uniform randoms → one normal random
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);

  const raw = Math.exp(mu + sigma * z);
  return Math.max(minSec, Math.min(maxSec, Math.round(raw)));
}
