-- Domain enums -------------------------------------------------------------
create type public.user_role as enum ('borrower', 'lender');
create type public.request_status as enum ('draft','submitted','under_review','approved','declined','funded');
create type public.request_type as enum ('application','credit_release');

-- Profiles ------------------------------------------------------------------
-- Role lives here, in trusted database state. It is never accepted from a browser.
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        public.user_role not null default 'borrower',
  full_name   text,
  created_at  timestamptz not null default now()
);

-- Loans ---------------------------------------------------------------------
-- Money is integer cents. available_credit is DERIVED (credit_limit - balance)
-- and deliberately not stored, so the two can never disagree.
create table public.loans (
  id            uuid primary key default gen_random_uuid(),
  borrower_id   uuid not null references public.profiles(id) on delete cascade,
  credit_limit  bigint not null,
  balance       bigint not null default 0,
  currency      text not null default 'CAD',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint loans_credit_limit_non_negative check (credit_limit >= 0),
  constraint loans_balance_non_negative       check (balance >= 0),
  constraint loans_balance_within_limit       check (balance <= credit_limit)
);

-- Form schemas --------------------------------------------------------------
-- The application form is lender-defined data. Adding a field is a data change.
create table public.form_schemas (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  version    integer not null default 1,
  steps      jsonb not null default '[]'::jsonb,
  rules      jsonb not null default '[]'::jsonb,
  active     boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index form_schemas_one_active on public.form_schemas (active) where active;

-- Requests ------------------------------------------------------------------
create table public.requests (
  id            uuid primary key default gen_random_uuid(),
  type          public.request_type not null,
  borrower_id   uuid not null references public.profiles(id) on delete cascade,
  loan_id       uuid references public.loans(id) on delete restrict,
  schema_id     uuid references public.form_schemas(id) on delete restrict,
  amount        bigint not null default 0,
  purpose       text,
  payload       jsonb not null default '{}'::jsonb,
  draft_step    integer not null default 0,
  status        public.request_status not null,
  eligibility   jsonb,
  decline_note  text,
  version       integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint requests_amount_non_negative check (amount >= 0),
  constraint requests_version_positive    check (version >= 1),
  constraint requests_draft_step_sane     check (draft_step >= 0 and draft_step <= 20),
  -- A credit release always draws against an existing loan.
  constraint requests_credit_release_needs_loan
    check (type <> 'credit_release' or loan_id is not null),
  -- A credit release is always for a positive amount.
  constraint requests_credit_release_positive_amount
    check (type <> 'credit_release' or amount > 0),
  -- Only an application is ever a draft.
  constraint requests_draft_is_application_only
    check (status <> 'draft' or type = 'application'),
  -- A decline must carry its reason.
  constraint requests_declined_has_note
    check (status <> 'declined' or (decline_note is not null and length(btrim(decline_note)) > 0))
);

-- Event log -----------------------------------------------------------------
-- Append-only. The borrower timeline and the audit trail are the same rows.
-- History is read from here, never reconstructed from current status.
create table public.request_events (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.requests(id) on delete cascade,
  from_status public.request_status,
  to_status   public.request_status not null,
  actor_id    uuid references public.profiles(id) on delete set null,
  actor_role  public.user_role,
  note        text,
  created_at  timestamptz not null default now()
);

-- Indexes -------------------------------------------------------------------
create index loans_borrower_idx          on public.loans (borrower_id);
create index requests_borrower_idx       on public.requests (borrower_id);
create index requests_queue_idx          on public.requests (status, created_at desc);
create index requests_loan_idx           on public.requests (loan_id);
create index request_events_request_idx  on public.request_events (request_id, created_at);
