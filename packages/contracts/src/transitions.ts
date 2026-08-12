/**
 * The state machine.
 *
 * This file is the ONLY definition of what moves are legal. The API enforces it;
 * the Angular client derives its buttons from it. Because both import the same
 * map, the UI cannot offer a transition the server will reject.
 *
 *   draft → submitted → under_review → approved → funded
 *                     ↘             ↗
 *                       → declined
 *
 * `draft` exists only for `application`. `credit_release` starts at `submitted`.
 * Terminal: `declined`, `funded`.
 */

import type {
  Cents,
  Eligibility,
  RequestStatus,
  RequestType,
  Role,
} from './domain.js';
import { availableCredit } from './domain.js';

// ---------------------------------------------------------------------------
// Guard plumbing
// ---------------------------------------------------------------------------

export interface GuardContext {
  type: RequestType;
  amount: Cents;
  note: string | null | undefined;
  eligibility: Eligibility | null;
  payload: Record<string, unknown>;
  /** Null for an application that has no loan yet. */
  loan: { creditLimit: Cents; balance: Cents } | null;
  /** Required-field keys, derived from the active form schema. */
  requiredFields: readonly string[];
}

export type GuardFailureCode =
  | 'amount_not_positive'
  | 'amount_exceeds_available_credit'
  | 'insufficient_credit_at_funding'
  | 'note_required'
  | 'fast_track_requires_green'
  | 'missing_required_fields'
  | 'loan_required';

export interface GuardFailure {
  ok: false;
  code: GuardFailureCode;
  message: string;
}

export type GuardResult = { ok: true } | GuardFailure;

const OK: GuardResult = { ok: true };

function fail(code: GuardFailureCode, message: string): GuardFailure {
  return { ok: false, code, message };
}

export type GuardKey =
  | 'amount_within_available_credit'
  | 'credit_available_at_funding'
  | 'note_present'
  | 'eligibility_green'
  | 'required_fields_present';

/**
 * Guards are pure. They are run server-side at transition time, and the same
 * functions drive the client's "why is this button disabled" copy.
 */
export const GUARDS: Record<GuardKey, (ctx: GuardContext) => GuardResult> = {
  /** Creation guard for a credit release: 0 < amount <= available credit. */
  amount_within_available_credit(ctx) {
    if (!Number.isInteger(ctx.amount) || ctx.amount <= 0) {
      return fail('amount_not_positive', 'Amount must be greater than zero.');
    }
    if (ctx.type === 'credit_release') {
      if (!ctx.loan) {
        return fail('loan_required', 'A credit release requires an existing loan.');
      }
      const available = availableCredit(ctx.loan);
      if (ctx.amount > available) {
        return fail(
          'amount_exceeds_available_credit',
          'Amount exceeds the available credit on this loan.',
        );
      }
    }
    return OK;
  },

  /**
   * Re-checked at funding time against the CURRENT loan aggregate, not against
   * whatever was true at approval. Approval does not reserve credit, so two
   * approved requests can compete for the same headroom and only one can win.
   */
  credit_available_at_funding(ctx) {
    if (ctx.type !== 'credit_release') return OK;
    if (!ctx.loan) {
      return fail('loan_required', 'A credit release requires an existing loan.');
    }
    if (ctx.amount > availableCredit(ctx.loan)) {
      return fail(
        'insufficient_credit_at_funding',
        'Available credit has changed since this request was approved.',
      );
    }
    return OK;
  },

  note_present(ctx) {
    if (!ctx.note || ctx.note.trim().length === 0) {
      return fail('note_required', 'A reason is required to decline a request.');
    }
    return OK;
  },

  /** Fast track: only a clean file may skip review. */
  eligibility_green(ctx) {
    if (ctx.eligibility?.level !== 'green') {
      return fail(
        'fast_track_requires_green',
        'Only a request with no eligibility warnings can be approved without review.',
      );
    }
    return OK;
  },

  required_fields_present(ctx) {
    const missing = ctx.requiredFields.filter((key) => {
      const value = ctx.payload[key];
      return value === undefined || value === null || value === '';
    });
    if (missing.length > 0) {
      return fail(
        'missing_required_fields',
        `Missing required field(s): ${missing.join(', ')}.`,
      );
    }
    return OK;
  },
};

// ---------------------------------------------------------------------------
// The transition map
// ---------------------------------------------------------------------------

export interface TransitionDef {
  /** Null means creation. */
  from: RequestStatus | null;
  to: RequestStatus;
  actor: Role;
  /** Which payload types this move is legal for. */
  appliesTo: readonly RequestType[];
  guards: readonly GuardKey[];
  /** Button label on the review/servicing screens. */
  label: string;
  intent: 'primary' | 'default' | 'danger';
  /** Whether the UI must collect a note before dispatching. */
  requiresNote: boolean;
  /** Past-tense line written into the event log. */
  eventLabel: string;
}

export const TRANSITIONS: readonly TransitionDef[] = [
  {
    from: null,
    to: 'draft',
    actor: 'borrower',
    appliesTo: ['application'],
    guards: [],
    label: 'Start application',
    intent: 'primary',
    requiresNote: false,
    eventLabel: 'Application started',
  },
  {
    from: 'draft',
    to: 'submitted',
    actor: 'borrower',
    appliesTo: ['application'],
    guards: ['required_fields_present'],
    label: 'Submit application',
    intent: 'primary',
    requiresNote: false,
    eventLabel: 'Application submitted',
  },
  {
    from: null,
    to: 'submitted',
    actor: 'borrower',
    appliesTo: ['credit_release'],
    guards: ['amount_within_available_credit'],
    label: 'Request credit release',
    intent: 'primary',
    requiresNote: false,
    eventLabel: 'Credit release requested',
  },
  {
    from: 'submitted',
    to: 'under_review',
    actor: 'lender',
    appliesTo: ['application', 'credit_release'],
    guards: [],
    label: 'Start review',
    intent: 'primary',
    requiresNote: false,
    eventLabel: 'Review started',
  },
  {
    // Fast track. Applications only, and only when nothing is flagged.
    // A credit release always routes through review.
    from: 'submitted',
    to: 'approved',
    actor: 'lender',
    appliesTo: ['application'],
    guards: ['eligibility_green'],
    label: 'Approve without review',
    intent: 'primary',
    requiresNote: false,
    eventLabel: 'Approved on fast track',
  },
  {
    from: 'under_review',
    to: 'approved',
    actor: 'lender',
    appliesTo: ['application', 'credit_release'],
    guards: ['amount_within_available_credit'],
    label: 'Approve',
    intent: 'primary',
    requiresNote: false,
    eventLabel: 'Approved',
  },
  {
    from: 'under_review',
    to: 'declined',
    actor: 'lender',
    appliesTo: ['application', 'credit_release'],
    guards: ['note_present'],
    label: 'Decline',
    intent: 'danger',
    requiresNote: true,
    eventLabel: 'Declined',
  },
  {
    from: 'approved',
    to: 'funded',
    actor: 'lender',
    appliesTo: ['application', 'credit_release'],
    guards: ['credit_available_at_funding'],
    label: 'Mark funded',
    intent: 'primary',
    requiresNote: false,
    eventLabel: 'Funds released',
  },
];

// ---------------------------------------------------------------------------
// Lookup + evaluation
// ---------------------------------------------------------------------------

export function findTransition(
  from: RequestStatus | null,
  to: RequestStatus,
  type: RequestType,
): TransitionDef | undefined {
  return TRANSITIONS.find(
    (t) => t.from === from && t.to === to && t.appliesTo.includes(type),
  );
}

/**
 * Every transition legal from this state, for this role and payload type,
 * before guards are evaluated. Drives which buttons exist at all.
 */
export function legalTransitions(
  from: RequestStatus,
  role: Role,
  type: RequestType,
): TransitionDef[] {
  return TRANSITIONS.filter(
    (t) => t.from === from && t.actor === role && t.appliesTo.includes(type),
  );
}

export type TransitionRejection =
  | { kind: 'illegal'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'guard'; failure: GuardFailure };

export type TransitionDecision =
  | { allowed: true; transition: TransitionDef }
  | { allowed: false; rejection: TransitionRejection };

/**
 * The single authorization decision, used by the API on every transition and by
 * the UI to decide whether to render an action as enabled.
 *
 * Order matters: legality first (is this move in the map at all), then actor
 * permission, then the domain guard. It means a borrower attempting a lender
 * move gets 403 rather than a guard message that leaks review semantics.
 */
export function evaluateTransition(input: {
  from: RequestStatus | null;
  to: RequestStatus;
  role: Role;
  ctx: GuardContext;
}): TransitionDecision {
  const { from, to, role, ctx } = input;

  const transition = findTransition(from, to, ctx.type);
  if (!transition) {
    return {
      allowed: false,
      rejection: {
        kind: 'illegal',
        message: `${from ?? 'new'} → ${to} is not a legal transition for a ${ctx.type.replace('_', ' ')}.`,
      },
    };
  }

  if (transition.actor !== role) {
    return {
      allowed: false,
      rejection: {
        kind: 'forbidden',
        message: `A ${role} cannot perform ${from ?? 'new'} → ${to}.`,
      },
    };
  }

  for (const key of transition.guards) {
    const result = GUARDS[key](ctx);
    if (!result.ok) {
      return { allowed: false, rejection: { kind: 'guard', failure: result } };
    }
  }

  return { allowed: true, transition };
}

/**
 * Actions to render on a review screen, each already carrying whether its guard
 * currently passes. A blocked action is shown disabled with the reason rather
 * than hidden, so the lender understands why.
 */
export interface AvailableAction {
  transition: TransitionDef;
  enabled: boolean;
  blockedReason: string | null;
}

export function availableActions(input: {
  from: RequestStatus;
  role: Role;
  ctx: GuardContext;
}): AvailableAction[] {
  return legalTransitions(input.from, input.role, input.ctx.type).map((transition) => {
    for (const key of transition.guards) {
      // A note the user has not typed yet must not read as a hard block.
      if (key === 'note_present' && transition.requiresNote) continue;
      const result = GUARDS[key](input.ctx);
      if (!result.ok) {
        return { transition, enabled: false, blockedReason: result.message };
      }
    }
    return { transition, enabled: true, blockedReason: null };
  });
}
