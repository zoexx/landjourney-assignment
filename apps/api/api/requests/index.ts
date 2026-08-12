/**
 * GET  /api/requests — the role-scoped list
 * POST /api/requests — creation
 *
 * Creation is a transition like any other: `null → submitted` for a credit
 * release, `null → draft` for an application. Both are decided by
 * evaluateTransition() rather than by an ad-hoc role check here, so the edge list
 * in @lj/contracts stays the only place that says who may start what, and a
 * lender attempting to raise a request on someone's behalf is refused by the
 * same rule that governs every other move.
 *
 * Nothing identifying is taken from the body. The borrower is the authenticated
 * actor and the loan is looked up from the database — a body-supplied loan id
 * would let one borrower draw against another's facility.
 */

import {
  evaluateTransition,
  type GuardContext,
  type RequestStatus,
  type TransitionRejection,
} from '@lj/contracts';
import {
  createRequestSchema,
  queueQuerySchema,
  type CreateRequestBody,
} from '@lj/contracts/schemas';
import { authenticate, type Actor } from '../../lib/auth.js';
import {
  applyCors,
  handlePreflight,
  methodNotAllowed,
  readJsonBody,
  sendError,
  sendOk,
  type VercelRequest,
  type VercelResponse,
} from '../../lib/http.js';
import {
  loadActiveSchema,
  loadEvents,
  loadLoan,
  loadLoanForBorrower,
  loadRequest,
  loadRequests,
} from '../../lib/repo.js';

/** Postgres raises this when a row fails an RLS `with check` clause. */
const PG_RLS_VIOLATION = '42501';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    return methodNotAllowed(res, ['GET', 'POST']);
  }

  const auth = await authenticate(req);
  if (!auth.ok) return sendError(res, 'unauthenticated', auth.message);
  const { actor } = auth;

  if (req.method === 'GET') return list(actor, req, res);

  const parsed = createRequestSchema.safeParse(readJsonBody(req));
  if (!parsed.success) {
    return sendError(res, 'validation_failed', 'That request could not be created.', {
      fields: parsed.error.issues.map((i) => ({
        key: i.path.join('.') || 'body',
        message: i.message,
      })),
    });
  }

  return parsed.data.type === 'credit_release'
    ? createCreditRelease(actor, parsed.data, res)
    : startApplication(actor, res);
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

/** Query values arrive as `string | string[]`; the filters are all single-valued. */
function firstValue(req: VercelRequest, key: string): string | undefined {
  const raw = req.query?.[key];
  return Array.isArray(raw) ? raw[0] : raw;
}

async function list(actor: Actor, req: VercelRequest, res: VercelResponse): Promise<void> {
  const parsed = queueQuerySchema.safeParse({
    status: firstValue(req, 'status'),
    level: firstValue(req, 'level'),
    type: firstValue(req, 'type'),
  });

  if (!parsed.success) {
    return sendError(res, 'validation_failed', 'That filter was not valid.', {
      fields: parsed.error.issues.map((i) => ({
        key: i.path.join('.') || 'query',
        message: i.message,
      })),
    });
  }

  // Which rows this actor may see is RLS's decision, not a `where` clause here.
  // The filters below only narrow what is already visible.
  return sendOk(res, await loadRequests(actor.db, actor.role, parsed.data));
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

async function createCreditRelease(
  actor: Actor,
  body: Extract<CreateRequestBody, { type: 'credit_release' }>,
  res: VercelResponse,
): Promise<void> {
  // The facility is resolved from the borrower, not named by the caller.
  const loan = await loadLoanForBorrower(actor.db, actor.id);

  const ctx: GuardContext = {
    type: 'credit_release',
    amount: body.amount,
    // Accepted for the guards; a creation note has nowhere to live on the row and
    // the creation event is written by the database trigger.
    note: body.note ?? null,
    eligibility: null,
    payload: {},
    loan: loan ? { creditLimit: loan.creditLimit, balance: loan.balance } : null,
    requiredFields: [],
  };

  const decision = evaluateTransition({ from: null, to: 'submitted', role: actor.role, ctx });
  if (!decision.allowed) return reject(res, decision.rejection, 'submitted');

  // Unreachable while `amount_within_available_credit` refuses a release with no
  // loan. It narrows the type; it does not re-make the decision above.
  if (!loan) return sendError(res, 'internal', 'That request could not be created.');

  const { data, error } = await actor.db
    .from('requests')
    .insert({
      type: 'credit_release',
      borrower_id: actor.id,
      loan_id: loan.id,
      amount: body.amount,
      purpose: body.purpose ?? null,
      status: 'submitted',
      version: 1,
    })
    .select('id')
    .single();

  if (error || !data) return insertFailed(res, error);
  return sendCreated(actor, res, data.id as string);
}

async function startApplication(actor: Actor, res: VercelResponse): Promise<void> {
  const ctx: GuardContext = {
    type: 'application',
    amount: 0,
    note: null,
    eligibility: null,
    payload: {},
    loan: null,
    requiredFields: [],
  };

  // Decided before the schema is loaded, so a lender is refused for being a
  // lender rather than told whether a form happens to be published.
  const decision = evaluateTransition({ from: null, to: 'draft', role: actor.role, ctx });
  if (!decision.allowed) return reject(res, decision.rejection, 'draft');

  const schema = await loadActiveSchema(actor.db);
  if (!schema) {
    return sendError(res, 'not_found', 'No application form is currently published.');
  }

  const { data, error } = await actor.db
    .from('requests')
    .insert({
      type: 'application',
      borrower_id: actor.id,
      // Records which schema this draft answers.
      schema_id: schema.id,
      amount: 0,
      payload: {},
      draft_step: 0,
      status: 'draft',
      version: 1,
    })
    .select('id')
    .single();

  if (error || !data) return insertFailed(res, error);
  return sendCreated(actor, res, data.id as string);
}

// ---------------------------------------------------------------------------
// Shared responses
// ---------------------------------------------------------------------------

/** Creation rejections carry the same codes the transition endpoint returns. */
function reject(
  res: VercelResponse,
  rejection: TransitionRejection,
  to: RequestStatus,
): void {
  if (rejection.kind === 'forbidden') {
    return sendError(res, 'forbidden', rejection.message);
  }
  if (rejection.kind === 'illegal') {
    return sendError(res, 'illegal_transition', rejection.message, {
      attempted: { from: 'new', to },
    });
  }
  return sendError(res, 'guard_failed', rejection.failure.message, {
    attempted: { from: 'new', to },
  });
}

/** RLS is the backstop for a write the state machine should already have refused. */
function insertFailed(res: VercelResponse, error: { code?: string } | null): void {
  if (error?.code === PG_RLS_VIOLATION) {
    return sendError(res, 'forbidden', 'You do not have permission to create that request.');
  }
  return sendError(res, 'internal', 'That request could not be created.');
}

/**
 * The creation event is written by the `on_request_created` trigger, so the row
 * and its log are re-read rather than assembled here — the client renders what
 * the database holds, not what this handler believes it wrote.
 */
async function sendCreated(actor: Actor, res: VercelResponse, id: string): Promise<void> {
  const request = await loadRequest(actor.db, id);
  if (!request) return sendError(res, 'internal', 'The request could not be reloaded.');

  return sendOk(
    res,
    {
      request,
      events: await loadEvents(actor.db, id),
      loan: await loadLoan(actor.db, request.loanId),
    },
    201,
  );
}
