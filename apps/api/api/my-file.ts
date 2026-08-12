/**
 * GET /api/my-file
 *
 * The borrower's servicing screen in one round trip: the facility and everything
 * raised against it. Two reads are answered as one response because the screen
 * renders available credit alongside the requests that consume it — fetched
 * separately, the two could arrive out of step and show a balance that does not
 * match the list beside it.
 *
 * Whose file this is comes from the authenticated actor, never from a parameter.
 */

import { authenticate } from '../lib/auth.js';
import {
  applyCors,
  handlePreflight,
  methodNotAllowed,
  sendError,
  sendOk,
  type VercelRequest,
  type VercelResponse,
} from '../lib/http.js';
import { loadLoanForBorrower, loadRequests } from '../lib/repo.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, 'unauthenticated', auth.message);
  const { actor } = auth;

  return sendOk(res, {
    loan: await loadLoanForBorrower(actor.db, actor.id),
    requests: await loadRequests(actor.db, actor.role),
  });
}
