/**
 * Data access and row → domain mapping.
 *
 * Every read here goes through the caller's own client, so RLS is what scopes a
 * borrower to their own file and opens the queue to a lender. None of that
 * scoping is re-implemented as a `where` clause — doing so would create a second
 * place for the rule to live, and the two would eventually disagree.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  CreditRequest,
  Eligibility,
  EligibilityRule,
  FormSchema,
  Loan,
  QueueRow,
  RequestEvent,
  RequestStatus,
  RequestType,
  Role,
} from '@lj/contracts';

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

export function toLoan(row: Row): Loan {
  return {
    id: row['id'] as string,
    borrowerId: row['borrower_id'] as string,
    creditLimit: Number(row['credit_limit']),
    balance: Number(row['balance']),
    currency: (row['currency'] as string) ?? 'CAD',
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

function profileName(row: Row): string | null {
  const p = row['profiles'];
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    return ((p as Row)['full_name'] as string | null) ?? null;
  }
  return null;
}

export function toRequest(row: Row): CreditRequest {
  return {
    id: row['id'] as string,
    type: row['type'] as RequestType,
    borrowerId: row['borrower_id'] as string,
    borrowerName: profileName(row),
    loanId: (row['loan_id'] as string | null) ?? null,
    schemaId: (row['schema_id'] as string | null) ?? null,
    amount: Number(row['amount'] ?? 0),
    purpose: (row['purpose'] as string | null) ?? null,
    note: null,
    payload: (row['payload'] as Record<string, unknown>) ?? {},
    draftStep: Number(row['draft_step'] ?? 0),
    status: row['status'] as RequestStatus,
    eligibility: (row['eligibility'] as Eligibility | null) ?? null,
    declineNote: (row['decline_note'] as string | null) ?? null,
    version: Number(row['version'] ?? 1),
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

export function toEvent(row: Row): RequestEvent {
  return {
    id: row['id'] as string,
    requestId: row['request_id'] as string,
    fromStatus: (row['from_status'] as RequestStatus | null) ?? null,
    toStatus: row['to_status'] as RequestStatus,
    actorId: (row['actor_id'] as string | null) ?? null,
    actorRole: (row['actor_role'] as Role | null) ?? null,
    actorName: profileName(row),
    note: (row['note'] as string | null) ?? null,
    createdAt: row['created_at'] as string,
  };
}

export function toFormSchema(row: Row): FormSchema {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    version: Number(row['version'] ?? 1),
    steps: (row['steps'] as FormSchema['steps']) ?? [],
    rules: (row['rules'] as EligibilityRule[]) ?? [],
  };
}

// ---------------------------------------------------------------------------
// Selects
// ---------------------------------------------------------------------------

const REQUEST_COLUMNS =
  'id,type,borrower_id,loan_id,schema_id,amount,purpose,payload,draft_step,status,eligibility,decline_note,version,created_at,updated_at,profiles!requests_borrower_id_fkey(full_name)';

export async function loadActiveSchema(db: SupabaseClient): Promise<FormSchema | null> {
  const { data, error } = await db
    .from('form_schemas')
    .select('id,name,version,steps,rules')
    .eq('active', true)
    .maybeSingle();
  if (error || !data) return null;
  return toFormSchema(data as Row);
}

export async function loadRequest(
  db: SupabaseClient,
  id: string,
): Promise<CreditRequest | null> {
  const { data, error } = await db
    .from('requests')
    .select(REQUEST_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return null;
  return toRequest(data as Row);
}

export async function loadEvents(
  db: SupabaseClient,
  requestId: string,
): Promise<RequestEvent[]> {
  const { data, error } = await db
    .from('request_events')
    .select('id,request_id,from_status,to_status,actor_id,actor_role,note,created_at,profiles(full_name)')
    .eq('request_id', requestId)
    .order('created_at', { ascending: true });
  if (error || !data) return [];
  return (data as Row[]).map(toEvent);
}

export async function loadLoan(db: SupabaseClient, id: string | null): Promise<Loan | null> {
  if (!id) return null;
  const { data, error } = await db
    .from('loans')
    .select('id,borrower_id,credit_limit,balance,currency,created_at,updated_at')
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return null;
  return toLoan(data as Row);
}

export async function loadLoanForBorrower(
  db: SupabaseClient,
  borrowerId: string,
): Promise<Loan | null> {
  const { data, error } = await db
    .from('loans')
    .select('id,borrower_id,credit_limit,balance,currency,created_at,updated_at')
    .eq('borrower_id', borrowerId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return toLoan(data as Row);
}

export interface QueueFilter {
  status?: RequestStatus;
  level?: string;
  type?: RequestType;
}

/**
 * The role-scoped list. A lender gets the cross-borrower queue and a borrower
 * gets their own file — but that difference is enforced by RLS, not by the
 * branch below. The only thing role changes here is that a borrower's own
 * drafts are included, since a draft is theirs to resume.
 */
export async function loadRequests(
  db: SupabaseClient,
  role: Role,
  filter: QueueFilter = {},
): Promise<QueueRow[]> {
  let query = db
    .from('requests')
    .select(`${REQUEST_COLUMNS},loans(credit_limit,balance)`)
    .order('created_at', { ascending: false });

  if (filter.status) query = query.eq('status', filter.status);
  if (filter.type) query = query.eq('type', filter.type);
  if (role === 'lender') query = query.neq('status', 'draft');

  const { data, error } = await query;
  if (error || !data) return [];

  const rows = (data as Row[]).map((row) => {
    const request = toRequest(row);
    const loan = row['loans'] as Row | null;
    const eligibility = request.eligibility;
    return {
      id: request.id,
      type: request.type,
      borrowerName: request.borrowerName,
      amount: request.amount,
      status: request.status,
      eligibilityLevel: eligibility?.level ?? null,
      loanAvailableCredit: loan
        ? Number(loan['credit_limit']) - Number(loan['balance'])
        : null,
      version: request.version,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    } satisfies QueueRow;
  });

  return filter.level ? rows.filter((r) => r.eligibilityLevel === filter.level) : rows;
}
