/**
 * GET /api/requests/:id
 *
 * The detail read behind both the borrower's file and the lender's review
 * screen: the request, its event log and the loan it draws on, in one round
 * trip. The review screen decides which actions to offer from this state, so
 * serving it in pieces would let it reason about a half-loaded file.
 *
 * The read goes through RLS. A row this actor may not see is simply not there,
 * and that is answered as 404 rather than 403 — a 403 would confirm the id
 * exists, which is exactly what a borrower probing for other borrowers' files
 * would be looking for.
 */

import { authenticate } from '../../../lib/auth.js';
import {
  applyCors,
  handlePreflight,
  methodNotAllowed,
  sendError,
  sendOk,
  type VercelRequest,
  type VercelResponse,
} from '../../../lib/http.js';
import { loadEvents, loadLoan, loadRequest } from '../../../lib/repo.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const id = typeof req.query?.['id'] === 'string' ? req.query['id'] : null;
  if (!id) return sendError(res, 'validation_failed', 'A request id is required.');

  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, 'unauthenticated', auth.message);
  const { actor } = auth;

  const request = await loadRequest(actor.db, id);
  if (!request) {
    return sendError(res, 'not_found', 'That request could not be found.');
  }

  return sendOk(res, {
    request,
    events: await loadEvents(actor.db, id),
    loan: await loadLoan(actor.db, request.loanId),
  });
}
