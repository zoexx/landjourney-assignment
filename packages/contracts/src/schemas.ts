/**
 * Wire validation schemas.
 *
 * Kept out of the package barrel on purpose: these carry a runtime dependency on
 * zod, and the browser has no use for them. Importing them from
 * `@lj/contracts/schemas` keeps ~100kB of validator out of the client bundle
 * while the API still validates every input against one definition.
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

