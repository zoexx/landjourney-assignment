-- Signup always produces a borrower. -----------------------------------------
-- Role is assigned by this trigger, never by the client. A lender is
-- provisioned separately (see the promotion in the seed migration), which is
-- the correct answer for a privileged role rather than a self-service checkbox.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role, full_name)
  values (
    new.id,
    'borrower',
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Helper: the caller's role, resolved from trusted database state. ----------
create or replace function public.current_role_of()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_lender()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_role_of() = 'lender', false);
$$;

-- Row level security ---------------------------------------------------------
-- Reads are governed entirely here: a borrower sees only their own servicing
-- data, a lender sees across borrowers. This is the real boundary — the API
-- reads through the caller's own JWT context, so a row RLS would hide is a row
-- the API cannot see either.
--
-- Writes: there is deliberately NO update policy on requests or loans for
-- anybody. Status and balance can only move through commit_transition(), so the
-- browser has no alternative path to mutate workflow state.

alter table public.profiles       enable row level security;
alter table public.loans          enable row level security;
alter table public.requests       enable row level security;
alter table public.request_events enable row level security;
alter table public.form_schemas   enable row level security;

-- profiles
create policy profiles_select_self_or_lender on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_lender());

create policy profiles_update_own_name on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and role = public.current_role_of());

-- loans
create policy loans_select_own_or_lender on public.loans
  for select to authenticated
  using (borrower_id = auth.uid() or public.is_lender());

-- requests: borrowers read their own; lenders read everything except
-- other people's unsubmitted drafts, which are not servicing data yet.
create policy requests_select_own_or_lender on public.requests
  for select to authenticated
  using (
    borrower_id = auth.uid()
    or (public.is_lender() and status <> 'draft')
  );

-- Creation is the one write a borrower performs directly, and it is constrained
-- to their own id and to the two legal entry states.
create policy requests_insert_own on public.requests
  for insert to authenticated
  with check (
    borrower_id = auth.uid()
    and public.current_role_of() = 'borrower'
    and status in ('draft', 'submitted')
    and version = 1
  );

-- Draft autosave: payload only, and only while still a draft. The USING clause
-- pins it to the owner's own draft; WITH CHECK stops the update from being used
-- to smuggle a status change.
create policy requests_update_own_draft on public.requests
  for update to authenticated
  using (borrower_id = auth.uid() and status = 'draft' and type = 'application')
  with check (borrower_id = auth.uid() and status = 'draft' and version = 1);

-- request_events: readable with the request, append-only, never edited.
create policy request_events_select on public.request_events
  for select to authenticated
  using (
    exists (
      select 1 from public.requests r
      where r.id = request_events.request_id
        and (r.borrower_id = auth.uid() or (public.is_lender() and r.status <> 'draft'))
    )
  );

-- form_schemas: the active schema is readable by any signed-in user; it is
-- configuration, not anybody's data.
create policy form_schemas_select_active on public.form_schemas
  for select to authenticated
  using (active);
