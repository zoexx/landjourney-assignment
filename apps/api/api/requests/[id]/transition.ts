/**
 * POST /api/requests/:id/transition
 *
 * The ONE path by which a request's status can change. There is no endpoint that
 * accepts `{ status }` as a record update, and no table grant that would let the
 * browser write one directly.
 *
 * Order of operations, and why:
 *
 *   1. authenticate                — a decoded JWT proves nothing; verify it
 *   2. resolve role from profiles  — never from the client
 *   3. load the request + its loan — through RLS, so invisible rows stay invisible
 *   4. run the state machine       — legality, actor, guards, from @lj/contracts
 *   5. commit atomically           — status + version + side effect + event
 *   6. return authoritative state  — the client renders what the server says
 *
 * Step 4 is the assessed part and it lives in application code. Step 5 is a
 * database function only because the four writes it performs must not be able to
 * partially succeed; it holds no workflow knowledge beyond the edge list.
 */

import {
  evaluateTransition,
  requiredFieldKeys,
  transitionRequestSchema,
  type GuardContext,
} from '@lj/contracts';
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
import {
  loadActiveSchema,
  loadEvents,
  loadLoan,
  loadRequest,
} from '../../../lib/repo.js';

/** Postgres SQLSTATEs raised by commit_transition(). */
const PG_STALE = 'LJ001';
const PG_ILLEGAL = 'LJ002';
const PG_GUARD = 'LJ003';
const PG_FORBIDDEN = 'LJ004';
const PG_NOT_FOUND = 'LJ005';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const id = typeof req.query?.['id'] === 'string' ? req.query['id'] : null;
  if (!id) return sendError(res, 'validation_failed', 'A request id is required.');

  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, 'unauthenticated', auth.message);
  const { actor } = auth;

  const parsed = transitionRequestSchema.safeParse(readJsonBody(req));
  if (!parsed.success) {
    return sendError(res, 'validation_failed', 'That transition request was not valid.', {
      fields: parsed.error.issues.map((i) => ({
        key: i.path.join('.') || 'body',
        message: i.message,
      })),
    });
  }
  const { to, expectedVersion, note } = parsed.data;

  // Read through RLS. A borrower cannot even see another borrower's request, so
  // this is a 404 rather than a 403 — we do not confirm that the id exists.
  const request = await loadRequest(actor.db, id);
  if (!request) {
    return sendError(res, 'not_found', 'That request could not be found.');
  }

  const loan = await loadLoan(actor.db, request.loanId);
  const schema = request.type === 'application' ? await loadActiveSchema(actor.db) : null;

  const ctx: GuardContext = {
    type: request.type,
    amount: request.amount,
    note: note ?? null,
    eligibility: request.eligibility,
    payload: request.payload,
    loan: loan ? { creditLimit: loan.creditLimit, balance: loan.balance } : null,
    requiredFields: schema ? requiredFieldKeys(schema) : [],
  };

  // ---- The state machine decides. -----------------------------------------
  const decision = evaluateTransition({
    from: request.status,
    to,
    role: actor.role,
    ctx,
  });

  if (!decision.allowed) {
    const { rejection } = decision;
    if (rejection.kind === 'forbidden') {
      return sendError(res, 'forbidden', rejection.message);
    }
    if (rejection.kind === 'illegal') {
      return sendError(res, 'illegal_transition', rejection.message, {
        attempted: { from: request.status, to },
      });
    }
    return sendError(res, 'guard_failed', rejection.failure.message, {
      attempted: { from: request.status, to },
    });
  }

  // Cheap staleness check before touching the database, so the common case gets
  // a clean 409. The authoritative check is the CAS inside the transaction —
  // this one only saves a round trip, it is not what makes it safe.
  if (request.version !== expectedVersion) {
    return sendError(res, 'stale_version', 'This request changed while you were viewing it.', {
      currentVersion: request.version,
    });
  }

  // ---- Commit. ------------------------------------------------------------
  const { error } = await actor.db.rpc('commit_transition', {
    p_request_id: id,
    p_to_status: to,
    p_expected_version: expectedVersion,
    p_note: note ?? null,
  });

  if (error) {
    switch (error.code) {
      case PG_STALE: {
        const current = await loadRequest(actor.db, id);
        return sendError(res, 'stale_version', 'This request changed while you were viewing it.', {
          currentVersion: current?.version ?? request.version,
        });
      }
      case PG_ILLEGAL:
        return sendError(res, 'illegal_transition', error.message, {
          attempted: { from: request.status, to },
        });
      case PG_GUARD:
        return sendError(res, 'guard_failed', error.message, {
          attempted: { from: request.status, to },
        });
      case PG_FORBIDDEN:
        return sendError(res, 'forbidden', 'You do not have permission to perform that action.');
      case PG_NOT_FOUND:
        return sendError(res, 'not_found', 'That request could not be found.');
      default:
        return sendError(res, 'internal', 'That action did not complete.');
    }
  }

  // Return authoritative state. The client does not compute what happened — it
  // renders what came back, so a failed or partial action can never be shown as
  // a successful one.
  const updated = await loadRequest(actor.db, id);
  if (!updated) return sendError(res, 'internal', 'The request could not be reloaded.');

  return sendOk(res, {
    request: updated,
    events: await loadEvents(actor.db, id),
    loan: await loadLoan(actor.db, updated.loanId),
  });
}
