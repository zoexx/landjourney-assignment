-- One request actually awaiting a decision -----------------------------------
-- Without this the lender queue seeds empty of work. The only other seeded
-- request is `funded`, which is terminal, so a reviewer who signs in as the
-- lender first sees a queue with nothing to act on. This adds a live
-- `submitted` release so review -> approve -> fund can be exercised straight
-- away, in either sign-in order.
--
-- $25,000 against $60,000 of available credit: inside the submission guard, and
-- still inside the credit limit if the reviewer funds it (balance 40k -> 65k),
-- so the happy path completes rather than tripping the funding-time check.
do $$
declare
  v_borrower_id uuid;
  v_loan_id     uuid;
  v_req_id      uuid;
  v_created     timestamptz := now() - interval '2 days';
begin
  select u.id into v_borrower_id
    from auth.users u
   where u.email = 'borrower@example.com';

  -- Runs against a project without the demo fixture: nothing to attach to.
  if v_borrower_id is null then
    raise notice 'seed_pending_release: borrower@example.com absent, skipping';
    return;
  end if;

  -- Idempotent as a set: re-running the migrations must not stack up queue items.
  if exists (
    select 1
      from public.requests
     where borrower_id = v_borrower_id
       and type        = 'credit_release'
       and status      = 'submitted'
  ) then
    return;
  end if;

  select l.id into v_loan_id
    from public.loans l
   where l.borrower_id = v_borrower_id
   order by l.created_at
   limit 1;

  insert into public.requests (
    type, borrower_id, loan_id, amount, purpose, status, version, created_at, updated_at
  )
  values (
    'credit_release', v_borrower_id, v_loan_id, 25000_00,
    'Spring input purchase - seed and fertiliser',
    'submitted', 1, v_created, v_created
  )
  returning id into v_req_id;

  -- `on_request_created` has already written the null -> submitted event. Only
  -- its timestamp is corrected here, so the trigger remains the thing that
  -- writes creation history rather than being bypassed by the fixture.
  update public.request_events
     set created_at = v_created
   where request_id = v_req_id;
end $$;
