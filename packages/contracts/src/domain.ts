/**
 * Core domain vocabulary.
 *
 * These types are shared verbatim by the API and the Angular client. They are
 * the only place a status, role or request type is named.
 */

export const REQUEST_STATUSES = [
  'draft',
  'submitted',
  'under_review',
  'approved',
  'declined',
  'funded',
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const TERMINAL_STATUSES: readonly RequestStatus[] = ['declined', 'funded'];

export function isTerminal(status: RequestStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export const ROLES = ['borrower', 'lender'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Two payload shapes ride the same workflow.
 *
 * `credit_release` is the declared assignment option: an existing borrower draws
 * against an existing loan. `application` is the front door: a new borrower
 * applies via the schema-driven form and a loan is created on funding.
 *
 * Modelling them as one machine is deliberate — the guards, the event log, the
 * queue and the review screen are written once.
 */
export const REQUEST_TYPES = ['application', 'credit_release'] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

/** Rolled-up eligibility verdict. Worst level present wins. */
export const ELIGIBILITY_LEVELS = ['green', 'amber', 'red'] as const;
export type EligibilityLevel = (typeof ELIGIBILITY_LEVELS)[number];

/** Money is integer cents everywhere. Never a float. */
export type Cents = number;

export const CURRENCY = 'CAD' as const;

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export interface Loan {
  id: string;
  borrowerId: string;
  creditLimit: Cents;
  balance: Cents;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Available credit is DERIVED, never stored. Persisting both balance and
 * available credit invites them to disagree.
 */
export function availableCredit(loan: Pick<Loan, 'creditLimit' | 'balance'>): Cents {
  return loan.creditLimit - loan.balance;
}

export interface RuleOutcome {
  key: string;
  label: string;
  level: EligibilityLevel;
  detail: string;
}

export interface Eligibility {
  level: EligibilityLevel;
  outcomes: RuleOutcome[];
  /** ISO timestamp of when this verdict was computed server-side. */
  evaluatedAt: string;
}

export interface CreditRequest {
  id: string;
  type: RequestType;
  borrowerId: string;
  borrowerName: string | null;
  loanId: string | null;
  schemaId: string | null;
  amount: Cents;
  purpose: string | null;
  note: string | null;
  payload: Record<string, unknown>;
  draftStep: number;
  status: RequestStatus;
  eligibility: Eligibility | null;
  declineNote: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RequestEvent {
  id: string;
  requestId: string;
  fromStatus: RequestStatus | null;
  toStatus: RequestStatus;
  actorId: string | null;
  actorRole: Role | null;
  actorName: string | null;
  note: string | null;
  createdAt: string;
}

/** A request plus everything the detail screens need, in one round trip. */
export interface RequestDetail {
  request: CreditRequest;
  events: RequestEvent[];
  loan: Loan | null;
}

/** Row shape for the lender queue. */
export interface QueueRow {
  id: string;
  type: RequestType;
  borrowerName: string | null;
  amount: Cents;
  status: RequestStatus;
  eligibilityLevel: EligibilityLevel | null;
  loanAvailableCredit: Cents | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
