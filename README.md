# Ridgeline — agricultural lending servicing portal

| | |
|---|---|
| **Live app** | https://landjourney-web.vercel.app |
| **API** | https://landjourney-api.vercel.app |
| **Repository** | https://github.com/zoexx/landjourney-assignment |

**Option 3: the servicing portal.** An existing borrower draws against an
established credit facility; a lender reviews, approves and releases the funds.

The submission is built to demonstrate one thing:

> **The UI is a projection of a reliable business workflow, not the owner of that workflow.**

The application is deliberately small. The depth is in workflow correctness,
authorization, concurrency, atomicity and failure handling — not feature count.

---

## Demo accounts

| Account | Password | What it opens onto |
|---|---|---|
| `borrower@example.com` | `DemoBorrower2026` | A $100,000 facility with $40,000 drawn — **$60,000 available** — and one funded release in the history |
| `lender@example.com` | `DemoLender2026` | The cross-borrower review queue |

`example.com` is reserved by RFC 2606, so nothing here is ever deliverable.

> **On signup:** the Supabase project this is wired to still has **Confirm email
> enabled**, and the built-in SMTP rate-limits to a couple of sends per hour. New
> signups are therefore blocked before a user row is even created. The signup
> screen is fully built and correct, and works the moment that toggle is turned
> off in **Auth → Providers → Email**. See *Known gaps* below — I could not flip
> it programmatically and did not want to weaken an authentication control to
> route around it.

---

## Running it

```bash
pnpm install
# recreate the database in a fresh Supabase project (see supabase/README.md)
for f in supabase/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
pnpm run dev          # web on :4200, api on :3001
pnpm run test         # domain tests
pnpm run lint         # typecheck across the workspace
```

### Deployment

`.github/workflows/ci.yml` runs install → lint → test → build on every push, then
deploys **both** Vercel projects from `main`. The deploy job needs four repository
secrets and **skips itself with a notice rather than failing** when they are
absent, so a fork still gets a green pipeline:

| Secret | |
|---|---|
| `VERCEL_TOKEN` | account token |
| `VERCEL_ORG_ID` | team id |
| `VERCEL_PROJECT_ID_WEB` | `landjourney-web` |
| `VERCEL_PROJECT_ID_API` | `landjourney-api` |

> **Status, stated plainly:** those four secrets are **not set on this repository
> yet**, so the deploy job currently skips both legs with a notice instead of
> deploying. `VERCEL_TOKEN` has to be minted by the account owner, which is not
> something the build can do for itself. The live deployments above were made
> with exactly the commands in that job, run from the CLI. Adding the secrets
> turns push-to-deploy on with no change to the workflow file.
>
> The two project ids are `prj_7OfRQJbUbNU5YaeLPj6ksfOc8UdZ` (web) and
> `prj_bhsXhtATycMvdWXrbd47PetMgJkt` (api); the org is
> `team_ucus6vewEnZ67lEny9gWZJlA`.

The three **public** build values — `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`
and `API_BASE_URL` — are set as repository *variables* rather than secrets,
because none of them is secret: the publishable key is protected by RLS, not by
being hidden. `scripts/gen-env.mjs` now **fails the build** when `CI=true` or
`VERCEL=1` and `API_BASE_URL` is missing, so a pipeline can no longer go green
having produced a bundle that points at `localhost`.

Environment (`.env`, and set on both Vercel projects):

```
SUPABASE_URL=…
SUPABASE_PUBLISHABLE_KEY=…    # public by design; protected by RLS, not secrecy
API_BASE_URL=…                # web → api
WEB_ORIGIN=…                  # api CORS allow-list
```

---

## Architecture

```
apps/web            Angular 22, standalone, signals, zoneless.   Vercel project #1
apps/api            Node serverless functions. Owns the machine. Vercel project #2
packages/contracts  TRANSITIONS + GUARDS, the eligibility evaluator, wire schemas
api/                Bundled function output (generated; see api/README.md)
```

`packages/contracts` is what makes this a monorepo rather than two folders. The
transition map, the guards, the eligibility evaluator and the status copy are
imported by **both** runtimes. The API enforces them; the client derives its
buttons from them. The UI cannot offer a move the server will reject, because
there is one definition of legal.

---

## The workflow

```
draft ──▶ submitted ──▶ under_review ──▶ approved ──▶ funded
             │               │
             └──────────┐    └──▶ declined
      (fast track,      ▼
       applications)  approved
```

Terminal: `declined`, `funded`. `draft` exists only for applications; a credit
release starts at `submitted`.

| From | To | Actor | Guard | Effect |
|---|---|---|---|---|
| — | `submitted` | borrower | `0 < amount ≤ available credit` | create + creation event |
| `submitted` | `under_review` | lender | — | event |
| `submitted` | `approved` | lender | **applications only**, eligibility green | event |
| `under_review` | `approved` | lender | amount still within available credit | event |
| `under_review` | `declined` | lender | non-empty reason | event |
| `approved` | `funded` | lender | **sufficient credit at funding time** | move money + event |

Anything not in that table is refused. Illegal moves return **409** naming the
attempted transition; wrong-actor moves return **403**.

Two things the table is doing deliberately:

- **The fast track ties eligibility to legality.** Rules do not merely colour a
  panel — they decide which transitions exist. A credit release can *never* skip
  review, because that edge is declared for `application` only.
- **`funded` does type-specific work.** For a release it increases the loan
  balance; for an application it creates the loan. Same transition, different
  effect — which is what makes the parameterisation real rather than cosmetic.

### Where state lives

| Server (authoritative, survives refresh) | Client (ephemeral) |
|---|---|
| status, amount, version, timestamps | loading / pending flags |
| loan balance and credit limit | form input before submission |
| decline reason | selected filter |
| the full event history | error and conflict messages |

Angular signals hold the second column only. **Refreshing at any point in the
workflow returns the same authoritative state**, because none of it was ever
client-side.

---

## Authorization — three independent layers

1. **RLS in Postgres.** The real boundary. Borrowers are scoped to
   `borrower_id = auth.uid()`; lenders read across borrowers. The API executes
   every query with a client bound to the **caller's own JWT**, so a row RLS
   would hide is a row the server cannot read either — there is no service-role
   client anywhere in this codebase.
2. **The API.** Verifies the JWT against Supabase (a decoded token proves
   nothing), resolves the role from `profiles` — never from the request — and
   runs the state machine.
3. **The UI.** Renders only legal actions. **This layer is convenience, not
   security**, and is stated as such in `core/guards.ts`.

Roles come from the database. Signup can only ever produce a borrower (enforced
by a trigger on `auth.users`); the lender was **provisioned** by a single
`UPDATE`. A privileged role is granted, never self-selected.

### There is no second way to move state

RLS grants **no `UPDATE` that can change a status**. Exactly one update policy
exists — `requests_update_own_draft`, for form autosave — and its `WITH CHECK`
pins the row to `status = 'draft'` and `version = 1`, so it cannot be used to
move workflow state. `loans` has no update policy at all. The only path that
moves a status or a balance is `commit_transition()`. A `PATCH` straight to PostgREST with
`{"status":"approved"}` updates **zero rows** — verified, not assumed.

---

## The transaction boundary

A transition must not partially succeed. These four writes are one commit:

```
status update  +  version increment  +  domain side effect  +  event append
```

`commit_transition()` is `SECURITY DEFINER` because no role holds `UPDATE` on
those tables — that is precisely what makes it the only door. It is **not** a
bypass: it re-derives the actor from `auth.uid()` and reads their role from
`profiles`, so a caller cannot assert who they are.

**The workflow decision is not in the database.** Node runs the full machine —
legality, actor permission, guards, error taxonomy, copy — *before* calling. The
function additionally checks a small `allowed_transitions` edge table, which
mirrors only the *structure* of the map. Its job is a foreign key's job: refuse a
shape outside the graph even if something reaches the database by a path nobody
anticipated. Guards, ordering and effects are not in there.

---

## Concurrency

**Optimistic concurrency.** Every request carries a `version`; every transition
sends `expectedVersion`. The comparison happens **inside** the locked
transaction (`SELECT … FOR UPDATE`, then compare), which makes it a real
compare-and-set rather than check-then-write. A mismatch returns 409 and the UI
refetches. **It never retries** — a workflow command is not safe to replay.

**Cross-request contention.** Version checks alone are not enough. Given $60,000
available and two approved $40,000 requests, both were legitimately approvable —
approval does not reserve credit. Funding therefore re-checks the **loan
aggregate** at funding time, inside the same transaction that moves the money. The
second request is refused with a domain conflict rather than producing an
impossible balance. `balance <= credit_limit` is also a CHECK constraint, so the
invariant holds even if every layer above it were wrong.

**Idempotency is documented, not built.** The endpoint accepts a `commandId` and
ignores it. In production it would carry a `(request_id, command_id)` unique
index so a retried command returns the existing result instead of performing the
business operation twice. The prototype's protection is narrower and stated
honestly: the action is disabled while in flight, the store refuses a second
dispatch while one is pending, and **no business state is ever moved
optimistically**.

---

## Failure handling

The UI never claims a transition it did not get. Every command renders
server-returned state.

| Situation | What the user sees |
|---|---|
| Loading | Skeletons. Never a default or invented status. |
| In flight | That action disabled, labelled, others frozen. |
| Generic failure | Status unchanged, explained as not completed. |
| **Stale version** | "This request changed while you were viewing it." Refetches. |
| **Credit moved** | "Available credit has changed since this request was approved." Refetches. |
| Network uncertainty | Says we cannot confirm — then shows authoritative state. |

Status colour is never the only signal: every status and eligibility level
carries a glyph and a word.

---

## Tests

26 domain tests in `packages/contracts`, targeting invariants rather than
coverage: every legal transition, `submitted → funded` refused, `declined →
funded` refused, `funded` terminal, borrower-cannot-approve, decline-requires-
reason, the fast track refused for credit releases and for amber files, funding
to the exact limit allowed and one cent beyond refused, and the two-competing-
requests case.

```bash
pnpm run test
```

---

## Trade-offs and what was deliberately cut

Cut, and each would be a small, bounded addition:

- **Cancellation, request-more-info, partial approval** — one map entry, one
  guard, one button each. The map is built so that stays true.
- **Notifications, pagination, real money movement, document upload,
  multi-loan borrowers.**
- **Queue sorting** (the filter is built), **advanced empty states**, and a
  broad automated test suite — the demo paths are verified manually.

Accepted trade-offs:

- **Two Vercel projects** cost CORS configuration and a second env set. Chosen
  deliberately for the deployment separation.
- **The Vercel CLI cannot set a project's Root Directory non-interactively**, so
  both projects deploy from the repository root. Vercel only compiles TypeScript
  under the deployment root's `api/`, and tracing emitted imports to `apps/api`
  sources it never compiled — every route returned `ERR_MODULE_NOT_FOUND`.
  `scripts/build-api.mjs` therefore esbuild-bundles each handler into `api/` as a
  self-contained function, so nothing is left to resolve at runtime. The source
  of truth stays in `apps/api`; `api/*.js` is generated and gitignored.
- **`@supabase/supabase-js` is pinned to 2.112.2**, not the latest. pnpm's
  `minimumReleaseAge` supply-chain policy rejects packages published within 24
  hours; rather than disable the policy I pinned to a version that has aged out.

---

## Known gaps

Stated as decisions, not omissions:

1. **Fresh signup is blocked by a dashboard setting.** Confirm-email is on and
   the built-in SMTP is rate-limited, so signup fails before a user row exists.
   The screen is built and correct. I deliberately did **not** add a trigger to
   auto-confirm addresses — that weakens an authentication control, and it is the
   owner's call, not mine. One toggle in Auth → Providers → Email fixes it.
2. **The schema-driven application form is scaffolded but not finished** — see
   below.

---

## The bonus: a schema-driven application form

`form_schemas` holds `steps` and `rules` as JSONB, seeded and live. The
contracts package already ships the renderer's type model
(`FormField`/`FormStep`/`FormSchema`), `validatePayload()` shared by both
runtimes, and a pure `evaluateEligibility()` that runs client-side for live
feedback and server-side at transition time. The database columns
(`payload`, `draft_step`, `eligibility`, `schema_id`), the RLS policy for draft
autosave, and the `PATCH /api/requests/:id/draft` endpoint that recomputes
eligibility server-side are all built and working.

**What is not built is the Angular renderer** (`borrower/application.page.ts` is
still a placeholder). The core workflow was the committed scope and it came
first; this is the honest status rather than a claim.

---

## How AI was used

This was built with Claude Code doing the implementation throughout, directed
against a written plan.

- **Planning first.** The build plan and the design system were settled before
  any code, so the model was implementing decisions rather than inventing them.
- **The domain core was written centrally, not delegated.** The transition map,
  guards and the transaction boundary are the assessed parts; those were written
  and reviewed directly, with 26 tests green before any UI existed.
- **Three parallel sub-agents** then built the remaining API routes, the borrower
  screens, and the lender screens against strictly disjoint file ownership and a
  precise spec. Shared primitives (status badge, timeline, the named-command
  store) were written first specifically so three agents could not invent three
  vocabularies.
- **Verification was not delegated.** Every security claim in this README was
  checked with a real request against the live database — RLS isolation, the
  refused direct `PATCH`, the stale-version 409, the balance moving atomically.

Things that looked plausible and were wrong, caught by checking:

- `@shadng/sng-ui` declares `@angular/core: ^21` as a peer while this is Angular
  22. Installing it as a dependency would have conflicted on the first
  `pnpm install`; the copy-paste CLI sidesteps the peer range entirely.
- Vercel's function runtime parsed the compiled output as CommonJS and returned
  `FUNCTION_INVOCATION_FAILED` on every route, including a zero-import health
  probe. The cause was the **root** `package.json` missing `"type": "module"` —
  found by reading the runtime log rather than guessing.
- The seeded accounts log in fine but `example.com` is rejected at *signup* by
  Supabase's address validation, which is a different code path.

---

## What another two hours would buy

In priority order:

1. **Finish the dynamic form renderer** — the data model, validator, evaluator
   and autosave endpoint are already there; it is the Angular component that is
   missing.
2. **Real idempotency keys** on the transition endpoint.
3. **Integration tests** driving the HTTP surface, including the two-tab stale
   conflict and the competing-credit race, so those stop being manual checks.
   Both are currently verified by hand against the live API — every claim in the
   *Concurrency* section above was checked with real requests, not asserted.
4. **Queue sorting and keyboard-first navigation** on the lender screen.
5. **Observability** — structured logs around every transition, which is what
   makes "why is this request stuck in review" answerable in production.

A production system would additionally need administrative provisioning, richer
audit metadata, notification workflows, rate limiting, a migration strategy and a
security review. None of those are implemented and none are claimed.
