/**
 * PATCH /api/requests/:id/draft
 *
 * Autosave for the schema-driven application form.
 *
 * It writes form content and nothing else: the payload, how far through the
 * borrower has got, and the eligibility verdict derived from them. It cannot
 * move the request — `status` is the transition endpoint's alone, and the
 * `requests_update_own_draft` policy would refuse a row that left `draft`
 * regardless of what this code asked for.
 *
 * Eligibility is recomputed here rather than accepted from the client. The
 * borrower's live panel runs the same pure evaluator for instant feedback, but a
 * verdict a lender acts on cannot be one that was computed in a browser.
 */

import {
  evaluateEligibility,
  validatePayload,
  STATUS_COPY,
} from '@lj/contracts';
import { saveDraftSchema } from '@lj/contracts/schemas';
import { authenticate } from '../../../lib/auth.js';
import {
  applyCors,
  handlePreflight,
  methodNotAllowed,
  readJsonBody,
  sendError,
  sendOk,
  type VercelRequest,
  type VercelResponse,
} from '../../../lib/http.js';
import { loadActiveSchema, loadRequest } from '../../../lib/repo.js';

/**
 * The queue, the review screen and the creation guards all read
 * `requests.amount`; only the form reads `payload.amount`. Mirroring keeps the
 * column authoritative. Values that fail the schema's own bounds never reach
 * here — validatePayload has already rejected them.
 */
function mirroredAmount(payload: Record<string, unknown>): number | null {
  const raw = payload['amount'];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;
  if (req.method !== 'PATCH') return methodNotAllowed(res, ['PATCH']);

  const id = typeof req.query?.['id'] === 'string' ? req.query['id'] : null;
  if (!id) return sendError(res, 'validation_failed', 'A request id is required.');

  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, 'unauthenticated', auth.message);
  const { actor } = auth;

  const parsed = saveDraftSchema.safeParse(readJsonBody(req));
  if (!parsed.success) {
    return sendError(res, 'validation_failed', 'That draft could not be saved.', {
      fields: parsed.error.issues.map((i) => ({
        key: i.path.join('.') || 'body',
        message: i.message,
      })),
    });
  }
  const { payload, step } = parsed.data;

  // Read through RLS, so another borrower's draft is invisible rather than
  // forbidden — same reasoning as the detail route.
  const request = await loadRequest(actor.db, id);
  if (!request) {
    return sendError(res, 'not_found', 'That request could not be found.');
  }

  if (request.borrowerId !== actor.id) {
    return sendError(res, 'forbidden', 'This is not your application.');
  }
  if (request.type !== 'application') {
    return sendError(res, 'forbidden', 'Only an application has a draft form to save.');
  }
  if (request.status !== 'draft') {
    // Not a permission problem: the file is real and theirs, it has just moved on.
    return sendError(
      res,
      'illegal_transition',
      `This application is ${STATUS_COPY[request.status].label.toLowerCase()} and can no longer be edited.`,
      { attempted: { from: request.status, to: 'draft' } },
    );
  }

  const schema = await loadActiveSchema(actor.db);
  if (!schema) {
    return sendError(res, 'not_found', 'No application form is currently published.');
  }

  // Partial: a half-filled draft must not read as a rejection. Required fields
  // are enforced at the draft → submitted boundary, by the state machine.
  const fields = validatePayload(schema, payload, { partial: true });
  if (fields.length > 0) {
    return sendError(res, 'validation_failed', 'Some answers are not valid.', { fields });
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    payload,
    draft_step: step,
    eligibility: evaluateEligibility(schema.rules, payload, now),
    // No trigger maintains this, and an autosave is real activity on the file.
    updated_at: now,
  };

  const amount = mirroredAmount(payload);
  if (amount !== null) patch['amount'] = amount;

  const { data, error } = await actor.db
    .from('requests')
    .update(patch)
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (error) return sendError(res, 'internal', 'That draft could not be saved.');

  // The policy's `using` clause is part of the write, not just the read above. A
  // draft submitted between that read and this update matches no row, and comes
  // back here as zero rows rather than as a silent overwrite of a live request.
  if (!data) {
    return sendError(res, 'illegal_transition', 'This application is no longer a draft.', {
      attempted: { from: request.status, to: 'draft' },
    });
  }

  const updated = await loadRequest(actor.db, id);
  if (!updated) return sendError(res, 'internal', 'The draft could not be reloaded.');

  return sendOk(res, updated);
}
