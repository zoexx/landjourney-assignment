import { describe, expect, it } from 'vitest';
import type { GuardContext } from './transitions.js';
import { availableActions, evaluateTransition, findTransition } from './transitions.js';
import type { Eligibility, RequestType } from './domain.js';

const green: Eligibility = { level: 'green', outcomes: [], evaluatedAt: '2026-08-12T00:00:00Z' };
const amber: Eligibility = { level: 'amber', outcomes: [], evaluatedAt: '2026-08-12T00:00:00Z' };

/** Loan: $100,000 limit, $40,000 drawn, so $60,000 available. */
function ctx(over: Partial<GuardContext> = {}): GuardContext {
  return {
    type: 'credit_release' as RequestType,
    amount: 25_000_00,
    note: null,
    eligibility: null,
    payload: {},
    loan: { creditLimit: 100_000_00, balance: 40_000_00 },
    requiredFields: [],
    ...over,
  };
}

describe('legal transitions', () => {
  it('lender may start review on a submitted request', () => {
    const d = evaluateTransition({ from: 'submitted', to: 'under_review', role: 'lender', ctx: ctx() });
    expect(d.allowed).toBe(true);
  });

  it('lender may approve a request under review', () => {
    const d = evaluateTransition({ from: 'under_review', to: 'approved', role: 'lender', ctx: ctx() });
    expect(d.allowed).toBe(true);
  });

  it('lender may fund an approved request', () => {
    const d = evaluateTransition({ from: 'approved', to: 'funded', role: 'lender', ctx: ctx() });
    expect(d.allowed).toBe(true);
  });

  it('borrower may create a credit release within available credit', () => {
    const d = evaluateTransition({ from: null, to: 'submitted', role: 'borrower', ctx: ctx() });
    expect(d.allowed).toBe(true);
  });
});

describe('illegal transitions', () => {
  it('rejects submitted → funded', () => {
    const d = evaluateTransition({ from: 'submitted', to: 'funded', role: 'lender', ctx: ctx() });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.rejection.kind).toBe('illegal');
      expect(d.rejection.kind === 'illegal' && d.rejection.message).toContain('submitted → funded');
    }
  });

  it('rejects declined → funded', () => {
    const d = evaluateTransition({ from: 'declined', to: 'funded', role: 'lender', ctx: ctx() });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.rejection.kind).toBe('illegal');
  });

  it('rejects declined → approved', () => {
    const d = evaluateTransition({ from: 'declined', to: 'approved', role: 'lender', ctx: ctx() });
    expect(d.allowed).toBe(false);
  });

  it('treats funded as terminal', () => {
    for (const to of ['approved', 'declined', 'under_review', 'submitted'] as const) {
      const d = evaluateTransition({ from: 'funded', to, role: 'lender', ctx: ctx() });
      expect(d.allowed).toBe(false);
    }
  });

  it('never allows a credit release to skip review via the fast track', () => {
    // The fast track exists, but only for applications.
    expect(findTransition('submitted', 'approved', 'application')).toBeDefined();
    expect(findTransition('submitted', 'approved', 'credit_release')).toBeUndefined();

    const d = evaluateTransition({
      from: 'submitted',
      to: 'approved',
      role: 'lender',
      ctx: ctx({ eligibility: green }),
    });
    expect(d.allowed).toBe(false);
  });
});

describe('actor authorization', () => {
  it('rejects a borrower approving', () => {
    const d = evaluateTransition({ from: 'under_review', to: 'approved', role: 'borrower', ctx: ctx() });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.rejection.kind).toBe('forbidden');
  });

  it('rejects a borrower funding', () => {
    const d = evaluateTransition({ from: 'approved', to: 'funded', role: 'borrower', ctx: ctx() });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.rejection.kind).toBe('forbidden');
  });

  it('rejects a lender creating a request on a borrower behalf', () => {
    const d = evaluateTransition({ from: null, to: 'submitted', role: 'lender', ctx: ctx() });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.rejection.kind).toBe('forbidden');
  });

  it('reports forbidden before evaluating the guard', () => {
    // A borrower declining with no note must read as forbidden, not note_required —
    // the guard message would leak review semantics to the wrong actor.
    const d = evaluateTransition({ from: 'under_review', to: 'declined', role: 'borrower', ctx: ctx() });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.rejection.kind).toBe('forbidden');
  });
});

describe('guards', () => {
  it('requires a non-empty reason to decline', () => {
    const blank = evaluateTransition({ from: 'under_review', to: 'declined', role: 'lender', ctx: ctx({ note: '   ' }) });
    expect(blank.allowed).toBe(false);
    if (!blank.allowed && blank.rejection.kind === 'guard') {
      expect(blank.rejection.failure.code).toBe('note_required');
    }

    const withReason = evaluateTransition({
      from: 'under_review',
      to: 'declined',
      role: 'lender',
      ctx: ctx({ note: 'Insufficient operating history.' }),
    });
    expect(withReason.allowed).toBe(true);
  });

  it('rejects a credit release above available credit at creation', () => {
    const d = evaluateTransition({
      from: null,
      to: 'submitted',
      role: 'borrower',
      ctx: ctx({ amount: 60_000_01 }),
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed && d.rejection.kind === 'guard') {
      expect(d.rejection.failure.code).toBe('amount_exceeds_available_credit');
    }
  });

  it('rejects a non-positive amount', () => {
    for (const amount of [0, -1]) {
      const d = evaluateTransition({ from: null, to: 'submitted', role: 'borrower', ctx: ctx({ amount }) });
      expect(d.allowed).toBe(false);
      if (!d.allowed && d.rejection.kind === 'guard') {
        expect(d.rejection.failure.code).toBe('amount_not_positive');
      }
    }
  });

  it('re-checks credit at funding, not at approval', () => {
    // Two $40k requests are both approvable against $60k of headroom...
    const a = evaluateTransition({
      from: 'under_review',
      to: 'approved',
      role: 'lender',
      ctx: ctx({ amount: 40_000_00 }),
    });
    expect(a.allowed).toBe(true);

    // ...and the first funds fine.
    const first = evaluateTransition({
      from: 'approved',
      to: 'funded',
      role: 'lender',
      ctx: ctx({ amount: 40_000_00 }),
    });
    expect(first.allowed).toBe(true);

    // After it funds, balance is $80k of a $100k limit — $20k left.
    // The second $40k request can no longer be funded.
    const second = evaluateTransition({
      from: 'approved',
      to: 'funded',
      role: 'lender',
      ctx: ctx({ amount: 40_000_00, loan: { creditLimit: 100_000_00, balance: 80_000_00 } }),
    });
    expect(second.allowed).toBe(false);
    if (!second.allowed && second.rejection.kind === 'guard') {
      expect(second.rejection.failure.code).toBe('insufficient_credit_at_funding');
    }
  });

  it('allows funding exactly to the credit limit but not a cent beyond', () => {
    const exact = evaluateTransition({
      from: 'approved',
      to: 'funded',
      role: 'lender',
      ctx: ctx({ amount: 60_000_00 }),
    });
    expect(exact.allowed).toBe(true);

    const over = evaluateTransition({
      from: 'approved',
      to: 'funded',
      role: 'lender',
      ctx: ctx({ amount: 60_000_01 }),
    });
    expect(over.allowed).toBe(false);
  });

  it('gates the application fast track on a green file', () => {
    const app = { type: 'application' as RequestType, loan: null };

    const clean = evaluateTransition({
      from: 'submitted',
      to: 'approved',
      role: 'lender',
      ctx: ctx({ ...app, eligibility: green }),
    });
    expect(clean.allowed).toBe(true);

    const flagged = evaluateTransition({
      from: 'submitted',
      to: 'approved',
      role: 'lender',
      ctx: ctx({ ...app, eligibility: amber }),
    });
    expect(flagged.allowed).toBe(false);
    if (!flagged.allowed && flagged.rejection.kind === 'guard') {
      expect(flagged.rejection.failure.code).toBe('fast_track_requires_green');
    }

    // ...but an amber file may still route through review.
    const viaReview = evaluateTransition({
      from: 'submitted',
      to: 'under_review',
      role: 'lender',
      ctx: ctx({ ...app, eligibility: amber }),
    });
    expect(viaReview.allowed).toBe(true);
  });

  it('requires every required field before an application may be submitted', () => {
    const base = { type: 'application' as RequestType, loan: null, requiredFields: ['farmName', 'acreage'] };

    const incomplete = evaluateTransition({
      from: 'draft',
      to: 'submitted',
      role: 'borrower',
      ctx: ctx({ ...base, payload: { farmName: 'Willow Bend' } }),
    });
    expect(incomplete.allowed).toBe(false);
    if (!incomplete.allowed && incomplete.rejection.kind === 'guard') {
      expect(incomplete.rejection.failure.code).toBe('missing_required_fields');
      expect(incomplete.rejection.failure.message).toContain('acreage');
    }

    const complete = evaluateTransition({
      from: 'draft',
      to: 'submitted',
      role: 'borrower',
      ctx: ctx({ ...base, payload: { farmName: 'Willow Bend', acreage: 400 } }),
    });
    expect(complete.allowed).toBe(true);
  });
});

describe('availableActions — what the UI is allowed to render', () => {
  it('offers only start-review on a submitted credit release', () => {
    const actions = availableActions({ from: 'submitted', role: 'lender', ctx: ctx() });
    expect(actions.map((a) => a.transition.to)).toEqual(['under_review']);
  });

  it('offers approve and decline under review', () => {
    const actions = availableActions({ from: 'under_review', role: 'lender', ctx: ctx() });
    expect(actions.map((a) => a.transition.to).sort()).toEqual(['approved', 'declined']);
  });

  it('does not disable decline merely because no note is typed yet', () => {
    const decline = availableActions({ from: 'under_review', role: 'lender', ctx: ctx({ note: null }) })
      .find((a) => a.transition.to === 'declined');
    expect(decline?.enabled).toBe(true);
    expect(decline?.transition.requiresNote).toBe(true);
  });

  it('surfaces fund as blocked, with a reason, when credit has moved', () => {
    const actions = availableActions({
      from: 'approved',
      role: 'lender',
      ctx: ctx({ amount: 40_000_00, loan: { creditLimit: 100_000_00, balance: 80_000_00 } }),
    });
    const fund = actions.find((a) => a.transition.to === 'funded');
    expect(fund?.enabled).toBe(false);
    expect(fund?.blockedReason).toContain('Available credit has changed');
  });

  it('offers nothing on terminal states', () => {
    expect(availableActions({ from: 'funded', role: 'lender', ctx: ctx() })).toEqual([]);
    expect(availableActions({ from: 'declined', role: 'lender', ctx: ctx() })).toEqual([]);
  });

  it('offers a borrower nothing once a request is submitted', () => {
    for (const from of ['submitted', 'under_review', 'approved', 'funded', 'declined'] as const) {
      expect(availableActions({ from, role: 'borrower', ctx: ctx() })).toEqual([]);
    }
  });
});
