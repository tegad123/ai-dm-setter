/**
 * Check if an A/B test result is statistically significant using chi-squared test.
 */
export function checkStatisticalSignificance(
  resultsA: Record<string, unknown> | null,
  resultsB: Record<string, unknown> | null,
  countA: number,
  countB: number
): {
  significant: boolean;
  pValue: number;
  winner: string | null;
  summary: string;
} {
  const rA = (resultsA as any) || {};
  const rB = (resultsB as any) || {};

  const rateA = rA.responseRate ?? 0;
  const rateB = rB.responseRate ?? 0;
  const nA = countA || 1;
  const nB = countB || 1;

  // Simple z-test for proportions
  const pooledRate = (rateA * nA + rateB * nB) / (nA + nB);
  const se = Math.sqrt(pooledRate * (1 - pooledRate) * (1 / nA + 1 / nB));
  const z = se > 0 ? Math.abs(rateA - rateB) / se : 0;

  // Approximate p-value from z-score
  const pValue = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const significant = pValue < 0.05 && (nA + nB) >= 50;

  let winner: string | null = null;
  if (significant) {
    winner = rateA > rateB ? 'A' : 'B';
  }

  return {
    significant,
    pValue: Math.round(pValue * 10000) / 10000,
    winner,
    summary: significant
      ? `Variant ${winner} wins with p=${pValue.toFixed(4)}`
      : `Not yet significant (p=${pValue.toFixed(4)}, n=${nA + nB})`
  };
}
