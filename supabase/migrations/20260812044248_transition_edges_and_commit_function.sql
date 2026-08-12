-- Structural edge list -------------------------------------------------------
-- This mirrors the STRUCTURE of the transition map in packages/contracts, and
-- nothing else. It holds no guards, no ordering, no effects and no copy — the
-- workflow decision stays in application code, exactly as the brief requires.
--
-- Its job is the same as a foreign key's: refuse a shape that is not part of the
-- graph, even if something reaches the database by a path we did not anticipate.
create table public.allowed_transitions (
  from_status  public.request_status,
  to_status    public.request_status not null,
  actor_role   public.user_role not null,
  request_type public.request_type not null
);
create unique index allowed_transitions_edge
  on public.allowed_transitions (
    coalesce(from_status, 'draft'::public.request_status), to_status, actor_role, request_type
  );
alter table public.allowed_transitions enable row level security;
create policy allowed_transitions_select on public.allowed_transitions
  for select to authenticated using (true);

insert into public.allowed_transitions (from_status, to_status, actor_role, request_type) values
  (null,           'draft',        'borrower', 'application'),
  ('draft',        'submitted',    'borrower', 'application'),
  (null,           'submitted',    'borrower', 'credit_release'),
  ('submitted',    'under_review', 'lender',   'application'),
  ('submitted',    'under_review', 'lender',   'credit_release'),
  ('submitted',    'approved',     'lender',   'application'),
  ('under_review', 'approved',     'lender',   'application'),
  ('under_review', 'approved',     'lender',   'credit_release'),
  ('under_review', 'declined',     'lender',   'application'),
  ('under_review', 'declined',     'lender',   'credit_release'),
  ('approved',     'funded',       'lender',   'application'),
  ('approved',     'funded',       'lender',   'credit_release');

-- The single guarded write path ---------------------------------------------
-- Everything that must not partially succeed happens here, in one transaction:
--
--     status update + version increment + domain side effect + event append
--
-- SECURITY DEFINER because no role holds UPDATE on requests or loans — that is
-- what makes this the only way workflow state can move. It is not a bypass: the
-- actor is re-derived from auth.uid() and their role is read from profiles, so a
-- caller cannot assert who they are. Node has already run the full state machine
-- before calling; the checks below are defence in depth and the atomicity
-- boundary, not the workflow definition.
create or replace function public.commit_transition(
  p_request_id      uuid,
  p_to_status       public.request_status,
  p_expected_version integer,
  p_note            text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor       uuid := auth.uid();
  v_role        public.user_role;
  v_req         public.requests%rowtype;
  v_loan        public.loans%rowtype;
  v_available   bigint;
  v_new_loan_id uuid;
begin
  if v_actor is null then
    raise exception 'not authenticated' using errcode = 'LJ004';
  end if;

  select role into v_role from public.profiles where id = v_actor;
  if v_role is null then
    raise exception 'no profile for actor' using errcode = 'LJ004';
  end if;

  -- Serialise concurrent transitions on this request.
  select * into v_req from public.requests where id = p_request_id for update;
  if not found then
    raise exception 'request not found' using errcode = 'LJ005';
  end if;

  -- Optimistic concurrency: compare-and-set on version. Doing this inside the
  -- locked transaction makes it a real CAS rather than check-then-write.
  if v_req.version <> p_expected_version then
    raise exception 'stale version, current is %', v_req.version using errcode = 'LJ001';
  end if;

  -- Structural legality.
  if not exists (
    select 1 from public.allowed_transitions t
    where t.from_status is not distinct from v_req.status
      and t.to_status = p_to_status
      and t.actor_role = v_role
      and t.request_type = v_req.type
  ) then
    raise exception '% -> % is not legal for a % by a %',
      v_req.status, p_to_status, v_req.type, v_role using errcode = 'LJ002';
  end if;

  -- A borrower may only ever move their own request.
  if v_role = 'borrower' and v_req.borrower_id <> v_actor then
    raise exception 'not your request' using errcode = 'LJ004';
  end if;

  -- A decline must carry its reason.
  if p_to_status = 'declined' and (p_note is null or length(btrim(p_note)) = 0) then
    raise exception 'a reason is required to decline' using errcode = 'LJ003';
  end if;

  -- Domain side effect: releasing funds moves money. -------------------------
  if p_to_status = 'funded' then
    if v_req.type = 'credit_release' then
      select * into v_loan from public.loans where id = v_req.loan_id for update;
      if not found then
        raise exception 'loan not found' using errcode = 'LJ005';
      end if;

      -- Re-checked here against the CURRENT loan, not against what was true at
      -- approval. Approval does not reserve credit, so two approved requests
      -- can race for the same headroom and only one may win.
      v_available := v_loan.credit_limit - v_loan.balance;
      if v_req.amount > v_available then
        raise exception 'insufficient available credit: % requested, % available',
          v_req.amount, v_available using errcode = 'LJ003';
      end if;

      update public.loans
         set balance = balance + v_req.amount,
             updated_at = now()
       where id = v_loan.id;

    elsif v_req.type = 'application' then
      -- Funding an application establishes the credit facility itself.
      insert into public.loans (borrower_id, credit_limit, balance)
      values (v_req.borrower_id, v_req.amount, 0)
      returning id into v_new_loan_id;
    end if;
  end if;

  update public.requests
     set status       = p_to_status,
         version      = version + 1,
         decline_note = case when p_to_status = 'declined' then p_note else decline_note end,
         loan_id      = coalesce(v_new_loan_id, loan_id),
         updated_at   = now()
   where id = p_request_id;

  insert into public.request_events (request_id, from_status, to_status, actor_id, actor_role, note)
  values (p_request_id, v_req.status, p_to_status, v_actor, v_role, nullif(btrim(coalesce(p_note, '')), ''));

  return jsonb_build_object(
    'id', p_request_id,
    'from', v_req.status,
    'to', p_to_status,
    'version', v_req.version + 1,
    'loanId', coalesce(v_new_loan_id, v_req.loan_id)
  );
end;
$$;

revoke all on function public.commit_transition(uuid, public.request_status, integer, text) from public;
grant execute on function public.commit_transition(uuid, public.request_status, integer, text) to authenticated;

-- Creation is also a domain event ------------------------------------------
-- `null -> submitted` (or `null -> draft`) is written the moment a request row
-- appears, so history is complete from the first row and is never reconstructed
-- from current status.
create or replace function public.log_request_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.request_events (request_id, from_status, to_status, actor_id, actor_role, note)
  values (new.id, null, new.status, new.borrower_id, 'borrower', null);
  return new;
end;
$$;

create trigger on_request_created
  after insert on public.requests
  for each row execute function public.log_request_created();
