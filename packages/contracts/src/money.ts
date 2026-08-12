/** Money is integer cents. These are the only places it becomes a string. */

import type { Cents } from './domain.js';
import { CURRENCY } from './domain.js';

const FULL = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: CURRENCY,
  minimumFractionDigits: 2,
});

const COMPACT = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: CURRENCY,
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** `$25,000.00` — for detail screens and anywhere exactness matters. */
export function formatMoney(cents: Cents): string {
  return FULL.format(cents / 100);
}

/** `$25,000` — for dense table cells, only when the value is whole dollars. */
export function formatMoneyCompact(cents: Cents): string {
  return cents % 100 === 0 ? COMPACT.format(cents / 100) : FULL.format(cents / 100);
}

/** Parse user input ("25,000" / "$25,000.50") to cents. Null if unparseable. */
export function parseMoneyToCents(input: string): Cents | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (cleaned === '' || !/^-?\d*\.?\d*$/.test(cleaned)) return null;
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars)) return null;
  return Math.round(dollars * 100);
}
