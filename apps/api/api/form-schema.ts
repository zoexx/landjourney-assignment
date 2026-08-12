/**
 * GET /api/form-schema
 *
 * The application form is lender-defined data. The client fetches the active
 * schema and derives its steps, fields and validators from it, so adding a field
 * is a row change rather than a release.
 *
 * There is no `?id=` on this route. RLS exposes only the active schema, so which
 * one is live is a database fact and not a parameter a caller can choose.
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
import { loadActiveSchema } from '../lib/repo.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, 'unauthenticated', auth.message);

  const schema = await loadActiveSchema(auth.actor.db);
  if (!schema) {
    return sendError(res, 'not_found', 'No application form is currently published.');
  }

  return sendOk(res, schema);
}
