/**
 * Format a date to a locale string.
 */
export function formatDate(
  date: Date | string | number | undefined | null,
  opts?: Intl.DateTimeFormatOptions
): string {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...opts
  });
}

/**
 * Format a number as currency.
 */
export function formatCurrency(
  amount: number,
  currency = 'USD'
): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency
  }).format(amount);
}
