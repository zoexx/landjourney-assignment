# Database

The five migrations in `migrations/` are the exact statements applied to the
hosted project, exported from `supabase_migrations.schema_migrations`. They are
ordered and idempotent as a set — run them in filename order against a fresh
Supabase project to recreate the schema, RLS policies, the guarded
`commit_transition()` function, the seeded form schema and the demo accounts.

```bash
supabase db reset                     # local
# or, against a remote project:
for f in supabase/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

| Migration | What it establishes |
|---|---|
| `core_schema` | enums, `profiles` / `loans` / `form_schemas` / `requests` / `request_events`, CHECK constraints, indexes |
| `profile_provisioning_and_rls` | signup trigger (always `borrower`), role helpers, every RLS policy |
| `transition_edges_and_commit_function` | `allowed_transitions` edge list, `commit_transition()`, the creation-event trigger |
| `seed_form_schema` | the active application form and its eligibility rules, as data |
| `seed_demo_accounts` | the two demo logins, the seeded facility and one funded release with history |

`seed_demo_accounts` writes directly to `auth.users`. That is a deliberate
fixture: Supabase's signup endpoint rejects `example.com` addresses, and this
keeps the published demo credentials on an RFC 2606 reserved domain that can
never receive mail.
