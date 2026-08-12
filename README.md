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

> **On signup:** you can also create your own account — signup is live. A new
> account is always provisioned as a **borrower**, enforced by a trigger on
> `auth.users`; the lender role is granted, never self-selected. Note that
> Supabase rejects `example.com` at signup, so use a different domain.

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

Two stages, deliberately owned by different systems:

| | Runs | Owns |
|---|---|---|
| **GitHub Actions** | every push and PR | install · lint · test · build — the gate |
| **Vercel Git integration** | every push | deploying both projects |

`.github/workflows/ci.yml` has no deploy job. Vercel is connected directly to
this repository and deploys `main` to production and every other branch to a
preview. **No Vercel credential exists in GitHub at all** — no token, no org id,
no project ids — because nothing in Actions talks to Vercel.

That is the deliberate part. An Actions-driven deploy needs a long-lived
`VERCEL_TOKEN`, and it has to be **account-scoped**: project-scoped tokens
(`vcp_…`) authenticate against Vercel's REST API but not its CLI, which resolves
the authenticated user before doing anything and fails with `User not found`.
So the Actions route costs a credential that can deploy anything in the account,
to do a job the platform already does natively for free. The token was removed
rather than reduced, because the best-scoped secret is the one that does not
exist.

**Two deploy paths is the failure mode**, not one path or the other. An earlier
revision had Vercel's Git integration connected *and* CLI deploys running: every
push silently rebuilt both projects with default settings, so the API deployed
with no functions at all and the alias was reassigned to it. Every route returned
404 for about forty minutes while the CLI deploys appeared to succeed. Whichever
system deploys, exactly one system deploys.

Because both projects build from the repository root, each one's install, build
and output commands live in its **Vercel project settings** rather than in a
config file — one repository cannot hold two different root `vercel.json` files.
The root `vercel.json` carries only what is genuinely shared: the SPA rewrite,
scoped to exclude `/api` so it cannot shadow a function.

| Project | Build | Output |
|---|---|---|
| `landjourney-web` | `pnpm --filter web run build` | `apps/web/dist/web/browser` |
| `landjourney-api` | `node scripts/build-api.mjs` | `public` |

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
scripts/            build-api.mjs — bundles apps/api into .vercel/output
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

**Cross-request contention.** Version checks alone are not enough. Verified end to
end against the live API: two $40,000 requests were both approved against $60,000
of headroom (the balance did not move — approval reserves nothing), the first
funded to a balance of $80,000, and the second was refused with `guard_failed`
and *"Available credit has changed since this request was approved."* The balance
was unchanged by the refusal and the second request stayed `approved` rather than
being corrupted into a half-state. Given $60,000
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

## On time spent

The brief asks for two to three hours. This took substantially longer than that —
on the order of a full day of wall-clock, including a schema-driven application
form that Option 3 does not ask for.

Stating it because a reviewer would otherwise reasonably assume the stated window,
and because scoping judgment is a fair thing to assess. What the extra time went
into, in rough order: the deployment topology (two Vercel projects from one repo,
which cost more than the fifteen minutes budgeted), verifying claims against the
live system rather than asserting them, and the bonus form.

The core Option 3 workflow — the state machine, the transaction boundary,
authorization, concurrency and the two servicing screens — was complete and
tested well before the rest. If the right comparison is "what would three hours
have produced", it is roughly everything above *except* the application form, the
migration export and some of the failure-state polish.

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
- **The API is built through Vercel's Build Output API**, not by dropping files
  into a root `api/` directory. Vercel discovers `api/**` functions from the
  source tree it clones, so handlers *generated during the build* are never
  registered and the deployment ships with no functions at all — every route
  404s. That failure hid for a while behind the CLI, which uploads the working
  directory: the built bundles were present locally, gitignored, and therefore
  part of no commit. The deployment worked and could not be reproduced from a
  clean clone. `scripts/build-api.mjs` now esbuild-bundles each handler into
  `.vercel/output/functions/**.func` with an explicit route table, which is the
  contract for "the build produces the functions" — the same commit deploys
  identically from a laptop, from CI, or from Vercel's own builder.
- **Exactly one system deploys.** An earlier revision had Vercel's Git
  integration connected *and* CLI deploys running. Every push rebuilt both
  projects with default settings, so the API deployed with no functions and the
  production alias was reassigned to it, serving 404 on every route for about
  forty minutes while the CLI deploys appeared to succeed. Two deploy paths
  existed and the wrong one silently won. Deployment now belongs to Vercel's Git
  integration alone; Actions gates and does not deploy.

  What made it dangerous was not the 404 but the schedule: the clobbering
  happened on push, minutes after a verified-good CLI deploy, so every manual
  check passed and the service broke afterwards. The Git integration is now
  disconnected on both projects. One deploy path, one config per project, and it
  is the one under version control.

- **`@supabase/supabase-js` is pinned to 2.112.2**, not the latest. pnpm's
  `minimumReleaseAge` supply-chain policy rejects packages published within 24
  hours; rather than disable the policy I pinned to a version that has aged out.

---

## Known gaps

Stated as decisions, not omissions:

1. The autosave debounce window described under *The bonus* below.

> Signup was previously blocked by Supabase's *Confirm email* setting, and this
> section said so. Rather than route around it with a trigger that auto-confirms
> addresses — which weakens an authentication control — the toggle was left for
> the account owner to flip. It has been flipped, and signup now works.

---

## The bonus: a schema-driven application form

Built and live. The form is **lender-defined data, not markup**: a `form_schemas`
row holds `steps` and `rules` as JSONB, and Angular renders it at runtime.

- **Four field types** — `text`, `number`, `select`, `textarea` — and the
  renderer switches on `field.type` and nothing else. No code anywhere branches
  on a field *key*. Adding a field is a data change.
- **Validators are derived from the schema**, never written per field.
  `validatePayload()` runs client-side for live messages and server-side at the
  `draft → submitted` boundary — one definition, two consumers, so they cannot
  drift. Untouched fields are not shouted at until a submit is attempted.
- **Autosave to Postgres.** Edits debounce 800ms then `PATCH /api/requests/:id/draft`
  with `{ payload, step }`. Not localStorage, not component state. The step is
  saved alongside the values and flushed immediately on step change.
- **Resume.** A hard refresh mid-form returns to the same step with values
  intact — verified live: refreshed on step 2, came back on step 2 with the
  entered values restored and eligibility recomputed from the persisted payload.
- **Eligibility is evaluated in both runtimes.** The same pure evaluator runs
  client-side on every keystroke for the live panel (no network call per
  keystroke) and again **server-side** in the draft endpoint, which persists the
  verdict. Confirmed in the database: the row carried `eligibility.level` written
  by the server, not by the browser. A rule only appears once the questions it
  reads are answered, so a half-filled form does not read as a rejection.
- **Eligibility gates legality.** A green application may be approved straight
  from `submitted`; anything amber or red must route through `under_review`. That
  is the `eligibility_green` guard in the transition map, not a UI rule.

**One honest limitation:** the autosave debounce means a keystroke made in the
last 800ms before a hard refresh can be lost. Everything older is durable. A
`beforeunload` flush would narrow the window but not close it; the real fix is
optimistic local buffering reconciled on load, which was out of scope here. The
step marker and all settled values survive, which is what the durability claim
rests on.

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

1. **Real idempotency keys** on the transition endpoint.
2. **Integration tests** driving the HTTP surface, including the two-tab stale
   conflict and the competing-credit race, so those stop being manual checks.
   Both are currently verified by hand against the live API — every claim in the
   *Concurrency* section above was checked with real requests, not asserted.
3. **Queue sorting and keyboard-first navigation** on the lender screen.
4. **Observability** — structured logs around every transition, which is what
   makes "why is this request stuck in review" answerable in production.

A production system would additionally need administrative provisioning, richer
audit metadata, notification workflows, rate limiting, a migration strategy and a
security review. None of those are implemented and none are claimed.
