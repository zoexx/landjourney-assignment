/**
 * Eligibility evaluation.
 *
 * Rules are DATA, seeded alongside the form schema. This one pure evaluator runs
 * in both runtimes: in the browser for live feedback as the borrower types (no
 * network call per keystroke), and on the server at transition time so a lender
 * never sees a verdict that was computed in somebody's browser.
 *
 * The rules themselves are deliberately trivial. The interesting part is that
 * the verdict gates which transitions are legal — see the `eligibility_green`
 * guard — rather than merely colouring a panel.
 */

import type { Eligibility, EligibilityLevel, RuleOutcome } from './domain.js';

export interface EligibilityRule {
  key: string;
  label: string;
  /** Read a single numeric field from the payload. */
  field?: string;
  /**
   * Or compute one. Restricted to `a / b`, `a * b`, `a + b`, `a - b` over payload
   * keys and numeric literals — deliberately not a general expression language.
   */
  expr?: string;
  failBelow?: number;
  warnBelow?: number;
  failAbove?: number;
  warnAbove?: number;
  /** Optional human unit for the detail line, e.g. "x revenue". */
  unit?: string;
}

const RANK: Record<EligibilityLevel, number> = { green: 0, amber: 1, red: 2 };

/** Worst level present wins. */
export function rollUp(levels: readonly EligibilityLevel[]): EligibilityLevel {
  return levels.reduce<EligibilityLevel>(
    (worst, level) => (RANK[level] > RANK[worst] ? level : worst),
    'green',
  );
}

const EXPR = /^\s*([A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?)\s*([*/+-])\s*([A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?)\s*$/;

function readOperand(token: string, payload: Record<string, unknown>): number | null {
  if (/^\d/.test(token)) return Number(token);
  const raw = payload[token];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve a rule to a number, or null when the inputs it needs are not present
 * yet. A rule with missing inputs is reported as pending rather than failing —
 * a half-filled form should not read as a rejection.
 */
export function resolveValue(
  rule: EligibilityRule,
  payload: Record<string, unknown>,
): number | null {
  if (rule.field) return readOperand(rule.field, payload);
  if (!rule.expr) return null;

  const match = EXPR.exec(rule.expr);
  if (!match) return null;
  const [, leftToken, op, rightToken] = match;
  if (!leftToken || !op || !rightToken) return null;

  const left = readOperand(leftToken, payload);
  const right = readOperand(rightToken, payload);
  if (left === null || right === null) return null;

  switch (op) {
    case '/':
      return right === 0 ? null : left / right;
    case '*':
      return left * right;
    case '+':
      return left + right;
    case '-':
      return left - right;
    default:
      return null;
  }
}

function levelFor(rule: EligibilityRule, value: number): EligibilityLevel {
  if (rule.failBelow !== undefined && value < rule.failBelow) return 'red';
  if (rule.failAbove !== undefined && value > rule.failAbove) return 'red';
  if (rule.warnBelow !== undefined && value < rule.warnBelow) return 'amber';
  if (rule.warnAbove !== undefined && value > rule.warnAbove) return 'amber';
  return 'green';
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function detailFor(rule: EligibilityRule, value: number, level: EligibilityLevel): string {
  const shown = `${round(value)}${rule.unit ? ` ${rule.unit}` : ''}`;
  if (level === 'green') return `${shown} — within policy`;

  const threshold =
    level === 'red'
      ? (rule.failBelow ?? rule.failAbove)
      : (rule.warnBelow ?? rule.warnAbove);
  if (threshold === undefined) return shown;

  const below = level === 'red' ? rule.failBelow !== undefined : rule.warnBelow !== undefined;
  return below
    ? `${shown} — ${level === 'red' ? 'minimum' : 'prefer at least'} ${threshold}`
    : `${shown} — ${level === 'red' ? 'maximum' : 'prefer under'} ${threshold}`;
}

/**
 * Evaluate every rule against a payload.
 *
 * Rules whose inputs are absent are skipped entirely — they contribute no
 * outcome and cannot drag the roll-up down. `evaluatedAt` must be supplied by
 * the caller so the function stays pure and testable.
 */
export function evaluateEligibility(
  rules: readonly EligibilityRule[],
  payload: Record<string, unknown>,
  evaluatedAt: string,
): Eligibility {
  const outcomes: RuleOutcome[] = [];

  for (const rule of rules) {
    const value = resolveValue(rule, payload);
    if (value === null) continue;
    const level = levelFor(rule, value);
    outcomes.push({
      key: rule.key,
      label: rule.label,
      level,
      detail: detailFor(rule, value, level),
    });
  }

  return {
    level: rollUp(outcomes.map((o) => o.level)),
    outcomes,
    evaluatedAt,
  };
}

export const ELIGIBILITY_COPY: Record<EligibilityLevel, { label: string; summary: string }> = {
  green: {
    label: 'Clear',
    summary: 'Nothing on this file is outside policy.',
  },
  amber: {
    label: 'Review required',
    summary: 'Some values are outside preference. A lender needs to look at this.',
  },
  red: {
    label: 'Outside policy',
    summary: 'One or more values fall outside the minimum policy thresholds.',
  },
};
