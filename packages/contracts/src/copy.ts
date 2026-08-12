/**
 * Product copy for workflow states.
 *
 * Enums are not product copy. A borrower reads a sentence about their money, not
 * `under_review`. Status colour is never the only signal — every status here
 * carries a glyph and a word as well as a tone.
 */

import type { RequestStatus, Role } from './domain.js';

export type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'bad';

export interface StatusCopy {
  /** Short label for badges and table cells. */
  label: string;
  /** Non-colour signal, paired with tone everywhere it is rendered. */
  glyph: string;
  tone: Tone;
  /** What the borrower is told. Answers "where is my request?". */
  borrower: string;
  /** What the lender is told. Operational, not reassuring. */
  lender: string;
}

export const STATUS_COPY: Record<RequestStatus, StatusCopy> = {
  draft: {
    label: 'Not submitted',
    glyph: '○',
    tone: 'neutral',
    borrower: 'This application has not been submitted yet. Pick up where you left off.',
    lender: 'Still being filled in by the borrower. Not yet visible for review.',
  },
  submitted: {
    label: 'Submitted',
    glyph: '◔',
    tone: 'info',
    borrower:
      'Your request has been received and is waiting for a lender to review it.',
    lender: 'Waiting to be picked up. No reviewer has started on this yet.',
  },
  under_review: {
    label: 'Under review',
    glyph: '◑',
    tone: 'warn',
    borrower:
      'Your lender is reviewing this request. Nothing is required from you right now.',
    lender: 'Review in progress. Approve or decline to move this forward.',
  },
  approved: {
    label: 'Approved',
    glyph: '◕',
    tone: 'ok',
    borrower: 'Your request has been approved and is waiting for funds to be released.',
    lender: 'Approved. Credit is not consumed until this is marked funded.',
  },
  funded: {
    label: 'Funded',
    glyph: '●',
    tone: 'ok',
    borrower: 'The credit release has been completed.',
    lender: 'Funds released. The loan balance has been updated. This is final.',
  },
  declined: {
    label: 'Declined',
    glyph: '✕',
    tone: 'bad',
    borrower: 'This request was not approved. The reason is shown below.',
    lender: 'Declined with a recorded reason. This is final.',
  },
};

export function statusCopyFor(status: RequestStatus, role: Role): string {
  const copy = STATUS_COPY[status];
  return role === 'lender' ? copy.lender : copy.borrower;
}

/** Failure copy. The UI must never claim a business transition it did not get. */
export const FAILURE_COPY = {
  stale:
    'This request changed while you were viewing it. We have loaded the latest state.',
  insufficientCredit:
    'Available credit has changed since this request was approved. Review the updated loan balance before continuing.',
  generic:
    'That action did not complete. The request has been left exactly as it was.',
  network:
    'We could not confirm whether that action completed. The latest saved state is shown below.',
  forbidden: 'You do not have permission to perform that action.',
} as const;
