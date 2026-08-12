-- Demo accounts --------------------------------------------------------------
-- example.com is reserved by RFC 2606, so nothing here is ever deliverable.
--
-- Both accounts are created through the normal auth tables, which fires the
-- signup trigger and gives them role='borrower'. The lender is then PROMOTED —
-- a privileged role is provisioned, never self-selected. That promotion is the
-- only thing that distinguishes the two accounts.
do $$
declare
  v_lender_id   uuid := gen_random_uuid();
  v_borrower_id uuid := gen_random_uuid();
  v_loan_id     uuid;
  v_req_id      uuid;
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change_token_new, email_change
  )
  values
    ('00000000-0000-0000-0000-000000000000', v_lender_id, 'authenticated', 'authenticated',
     'lender@example.com', crypt('DemoLender2026', gen_salt('bf')),
     now(), now(), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     '{"full_name":"Dana Whitfield"}'::jsonb, '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', v_borrower_id, 'authenticated', 'authenticated',
     'borrower@example.com', crypt('DemoBorrower2026', gen_salt('bf')),
     now(), now(), now(),
     '{"provider":"email","providers":["email"]}'::jsonb,
     '{"full_name":"Ray Okonkwo"}'::jsonb, '', '', '', '');

  insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
  values
    (gen_random_uuid(), v_lender_id,
     jsonb_build_object('sub', v_lender_id::text, 'email', 'lender@example.com', 'email_verified', true),
     'email', v_lender_id::text, now(), now(), now()),
    (gen_random_uuid(), v_borrower_id,
     jsonb_build_object('sub', v_borrower_id::text, 'email', 'borrower@example.com', 'email_verified', true),
     'email', v_borrower_id::text, now(), now(), now());

  -- Provision the lender. This single UPDATE is the whole privilege model.
  update public.profiles set role = 'lender' where id = v_lender_id;

  -- The seeded borrower opens onto a populated servicing screen:
  -- a $100,000 facility with $40,000 drawn, leaving $60,000 available.
  insert into public.loans (borrower_id, credit_limit, balance)
  values (v_borrower_id, 100000_00, 40000_00)
  returning id into v_loan_id;

  -- ...and one completed release in the history, so the timeline is not empty.
  insert into public.requests (type, borrower_id, loan_id, amount, purpose, status, version, created_at, updated_at)
  values ('credit_release', v_borrower_id, v_loan_id, 40000_00, 'Operating',
          'funded', 5, now() - interval '26 days', now() - interval '24 days')
  returning id into v_req_id;

  -- Its history is written explicitly rather than inferred from the end state.
  delete from public.request_events where request_id = v_req_id;
  insert into public.request_events (request_id, from_status, to_status, actor_id, actor_role, note, created_at) values
    (v_req_id, null,           'submitted',    v_borrower_id, 'borrower', null, now() - interval '26 days'),
    (v_req_id, 'submitted',    'under_review', v_lender_id,   'lender',   null, now() - interval '25 days 4 hours'),
    (v_req_id, 'under_review', 'approved',     v_lender_id,   'lender',   null, now() - interval '25 days'),
    (v_req_id, 'approved',     'funded',       v_lender_id,   'lender',   null, now() - interval '24 days');
end $$;
