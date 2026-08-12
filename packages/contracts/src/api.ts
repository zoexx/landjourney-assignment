/**
 * Wire contracts.
 *
 * Zod schemas are the API's input validation and the client's request builders.
 * The client never sends `{ status: 'approved' }` as a record mutation — it asks
 * for a transition and the server decides.
 */

import { z } from 'zod';
import { REQUEST_STATUSES, REQUEST_TYPES } from './domain.js';

export const requestStatusSchema = z.enum(REQUEST_STATUSES);
export const requestTypeSchema = z.enum(REQUEST_TYPES);

/**
 * The one and only status-mutation payload.
 *
 * `expectedVersion` is mandatory: a transition that does not say which version it
 * believes it is acting on cannot be checked for staleness.
 *
 * `commandId` is accepted and echoed but NOT yet enforced — see the README. In
 * production it would carry a `(request_id, command_id)` unique index so a
 * retried command returns the existing result instead of performing the business
 * operation twice.
 */
export const transitionRequestSchema = z.object({
  to: requestStatusSchema,
  expectedVersion: z.number().int().min(1),
  note: z.string().trim().max(2000).optional(),
  commandId: z.string().uuid().optional(),
});
export type TransitionRequestBody = z.infer<typeof transitionRequestSchema>;

export const createRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('credit_release'),
    amount: z.number().int().positive(),
    purpose: z.string().trim().min(1).max(120).optional(),
    note: z.string().trim().max(2000).optional(),
  }),
  z.object({
    type: z.literal('application'),
  }),
]);
export type CreateRequestBody = z.infer<typeof createRequestSchema>;

export const saveDraftSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
  step: z.number().int().min(0).max(20),
});
export type SaveDraftBody = z.infer<typeof saveDraftSchema>;

export const queueQuerySchema = z.object({
  status: requestStatusSchema.optional(),
  level: z.enum(['green', 'amber', 'red']).optional(),
  type: requestTypeSchema.optional(),
});
export type QueueQuery = z.infer<typeof queueQuerySchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Machine-readable failure codes. The UI branches on these rather than on
 * message text — notably to tell a stale-version conflict apart from a generic
 * failure, which get very different copy.
 */
export const API_ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'not_found',
  'validation_failed',
  'illegal_transition',
  'stale_version',
  'guard_failed',
  'internal',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Present on `illegal_transition`: names the move that was attempted. */
    attempted?: { from: string; to: string };
    /** Present on `stale_version`. */
    currentVersion?: number;
    /** Present on `validation_failed`. */
    fields?: { key: string; message: string }[];
  };
}

export const HTTP_STATUS_FOR: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  illegal_transition: 409,
  stale_version: 409,
  guard_failed: 409,
  internal: 500,
};
