# Ridgeline — agricultural lending servicing portal

**Option 3 — the servicing portal.** An existing borrower draws against an
established credit facility; a lender reviews, approves and releases the funds.

Chosen because servicing is the option whose difficulty is *state* rather than
screens. A draw request is money moving between two parties who each see a
different view of it, so the hard parts are the ones worth being assessed on:
which transitions are legal and who may make them, what happens when two people
act on the same request at once, and whether a half-finished transition can leave
a balance wrong. Each of those has a verifiable answer, and this README points at
where to check it. A schema-driven intake form was then built as the bonus, so
forms at real complexity are covered too.

| | |
|---|---|
| **Live app** | https://landjourney-web.vercel.app |
| **API** | https://landjourney-api.vercel.app |
| **Repository** | https://github.com/zoexx/landjourney-assignment |

> **The UI is a projection of a reliable business workflow, not the owner of that
> workflow.**

The application is deliberately small. The depth is in workflow correctness,
authorization, concurrency, atomicity and failure handling — not feature count.

---

## Sign in

| Account | Password | Opens onto |
|---|---|---|
| `borrower@example.com` | `DemoBorrower2026` | A $100,000 facility, $40,000 drawn — **$60,000 available** — four requests spread across the workflow: one funded, one declined, one awaiting a lender decision, and an application part-way through the form |
| `lender@example.com` | `DemoLender2026` | The cross-borrower review queue |

Signup is live too, but a new account is always provisioned as a **borrower**
(enforced by a trigger on `auth.users`) — the lender role is granted, never
self-selected. Use a domain other than `example.com`, which Supabase rejects at
signup.

---

## A five-minute review path

If you only read six files, read these:

| | |
|---|---|
| `packages/contracts/src/transitions.ts` | The state machine. The **only** definition of what moves are legal, imported by both runtimes. |
| `supabase/migrations/*_transition_edges_and_commit_function.sql` | `commit_transition()` — the single door through which any status or balance moves. |
| `apps/api/api/requests/[id]/transition.ts` | The command endpoint: verify JWT → resolve role from the database → run the machine → commit. |
| `supabase/migrations/*_profile_provisioning_and_rls.sql` | Every RLS policy. Note that no policy can `UPDATE` a status. |
| `packages/contracts/src/transitions.test.ts` | 26 invariant tests — illegal moves, wrong actors, the exact-limit boundary, the competing-credit race. |
| `apps/web/src/app/core/guards.ts` | The client's route guards, whose own header states they are convenience and not authorization. |

In the running app: take the **$25,000 release already waiting in the lender
queue** through review → approve → fund, and watch the balance move atomically
with the event history. Then open one request in two tabs and act in both — the
second gets a 409 and a refetch, never a silent overwrite. Submitting a fresh
release as the borrower exercises the amount guard on the way in.

The other rows are already-finished work, left in place because they are worth
opening: the **declined $60,000 release** carries the full event history of a
completed decline — submitted, picked up, refused, each with actor and reason —
and the **draft application** resumes exactly where it was abandoned, which is
the autosave claim rather than a description of it.

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

Anything not in that table is refused: illegal moves return **409** naming the
attempted transition, wrong-actor moves return **403**.

Two things the table is doing deliberately. **The fast track ties eligibility to
legality** — rules do not merely colour a panel, they decide which transitions
exist, so a credit release can never skip review because that edge is declared
for `application` only. And **`funded` does type-specific work**: for a release it
increases the loan balance, for an application it creates the loan. Same
transition, different effect.

---

## The four guarantees

Each is summarised here and evidenced in
[docs/architecture.md](docs/architecture.md).

**Authorization is three independent layers.** RLS in Postgres is the real
boundary — the API runs every query with a client bound to the caller's own JWT,
so there is no service-role client anywhere in this codebase. The API verifies
the token and resolves the role from `profiles`, never from the request. The UI
renders only legal actions, and says of itself that this is convenience, not
security. → [Authorization](docs/architecture.md#authorization--three-independent-layers)

**A transition cannot partially succeed.** Status update, version increment,
domain side effect and event append are one commit inside `commit_transition()`.
It is `SECURITY DEFINER` because no role holds `UPDATE` on those tables — which
is precisely what makes it the only door — and it re-derives the actor from
`auth.uid()`, so a caller cannot assert who they are. A `PATCH` straight to
PostgREST with `{"status":"approved"}` updates zero rows; verified, not assumed.
→ [Transaction boundary](docs/architecture.md#the-transaction-boundary)

**Concurrency is compare-and-set, not check-then-write.** Every command carries
`expectedVersion` and the comparison happens inside the locked transaction
(`SELECT … FOR UPDATE`). It never retries — a workflow command is not safe to
replay. Approval reserves no credit, so funding re-checks the loan aggregate at
funding time: two $40,000 requests approved against $60,000 of headroom end with
one funded and one refused with a domain conflict, not an impossible balance.
Verified end to end against the live API. → [Concurrency](docs/architecture.md#concurrency)

**The UI never claims a transition it did not get.** Loading shows skeletons
rather than an invented status, in-flight actions are disabled and labelled, and
every outcome renders server-returned state. Stale-version and credit-moved
conflicts get their own plain-language messages and a refetch. → [Failure handling](docs/architecture.md#failure-handling)

---

## Running it

```bash
pnpm install
# recreate the database in a fresh Supabase project — see supabase/README.md
for f in supabase/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
pnpm run dev          # web on :4200, api on :3001
pnpm run test         # 26 domain tests
pnpm run lint         # typecheck across the workspace
```

Environment (`.env`, and set on both Vercel projects):

```
SUPABASE_URL=…
SUPABASE_PUBLISHABLE_KEY=…    # public by design; protected by RLS, not secrecy
API_BASE_URL=…                # web → api
WEB_ORIGIN=…                  # api CORS allow-list
```

Two systems, deliberately separate: **GitHub Actions gates** every push and PR
with install → lint → test → build, and **Vercel's Git integration deploys**.
Actions holds no Vercel credential at all, because nothing in it talks to Vercel.
→ [docs/deployment.md](docs/deployment.md)

---

## Layout

```
apps/web            Angular 22, standalone, signals, zoneless.   Vercel project #1
apps/api            Node serverless functions. Owns the machine. Vercel project #2
packages/contracts  TRANSITIONS + GUARDS, the eligibility evaluator, wire schemas
supabase/           Six migrations that recreate the database exactly
scripts/            build-api.mjs — bundles apps/api into .vercel/output
```

`packages/contracts` is what makes this a monorepo rather than two folders. The
API enforces the transition map; the client derives its buttons from it. The UI
cannot offer a move the server will reject, because there is one definition of
legal.

---

## The bonus, in one paragraph

A schema-driven application form is built and live. A `form_schemas` row holds
`steps` and `rules` as JSONB and Angular renders it at runtime — the renderer
switches on `field.type` and nothing else, no code branches on a field *key*, and
adding a field is a data change. Validators are derived from the schema and run
in both runtimes; edits autosave to Postgres, so a hard refresh mid-form resumes
on the same step with values intact. Eligibility is evaluated client-side for the
live panel and again server-side where it is persisted — and it gates legality,
not just colour. → [docs/application-form.md](docs/application-form.md)

What it would take to make this Option 2 proper — separating the form, the
answers, the policy and the file into four things with four lifecycles, and
fixing three defects the current version carries — is designed out in
[docs/option-2-plan.md](docs/option-2-plan.md).

---

## What another two hours would buy

In priority order:

1. **Real idempotency keys** on the transition endpoint, so a retried command is
   provably the same command rather than a second one.
2. **Integration tests over HTTP** covering the two-tab stale conflict and the
   competing-credit race. Both hold today, but they are verified by hand.
3. **Queue sorting and keyboard-first navigation** on the lender screen — the
   filter is built, the sort is not.
4. **Structured logs around every transition**, which is what makes "why is this
   request stuck in review" answerable in production.

Cut deliberately, each a bounded addition the transition map is built to absorb:
cancellation, request-more-info and partial approval are one map entry, one guard
and one button each. Notifications, pagination, document upload, real money
movement and multi-loan borrowers are not built and are not claimed.
→ [docs/process.md](docs/process.md)

---

## How I used AI

**Claude Code did the implementation throughout**, directed against a plan written
first, with the Supabase and Vercel MCP servers used for database and deployment
work.

**Planned before delegating.** [The build plan](docs/build-plan.md) and
[the design system](docs/design-tokens.md) were settled before any code existed,
so the model was implementing decisions rather than inventing them.

**Delegated:** the remaining API routes and the borrower and lender screens, built
by three parallel sub-agents against strictly disjoint file ownership. The shared
primitives — status badge, timeline, the named-command store — were written first
precisely so three agents could not invent three vocabularies for the same thing.

**Not delegated:** the domain core. The transition map, the guards and the
transaction boundary are the parts being assessed, so they were written and
reviewed directly, with 26 tests green before any UI existed. Verification was not
delegated either — every security claim in these docs was checked with a real
request against the live system.

### Rejected or rewritten

- **A service-role client** to make the funding transition atomic. It would have
  bypassed RLS, which is the actual security boundary. Replaced with a Postgres
  function that keeps both the transaction and RLS.
- **A trigger auto-confirming `auth.users`**, proposed to get around email
  confirmation blocking signup. It weakens an authentication control to save a
  click; the toggle was left for the account owner to flip instead.
- **Disabling pnpm's `minimumReleaseAge`** to install a same-day release. Pinned
  to an aged-out version rather than switch a supply-chain policy off.
- **`@shadng/sng-ui` as a dependency** — it declares `@angular/core: ^21` as a
  peer against this project's Angular 22. Used its copy-paste CLI instead, which
  is the library's primary usage mode.
- **CLI deploys from GitHub Actions**, rewritten entirely, and the Vercel token
  deleted rather than narrowed. Actions gates; Vercel deploys.

### Plausible and wrong

Each of these was caught by running the thing and reading the output, never by
re-reading the code.

- **The API served 404 on every route for about forty minutes while looking
  healthy.** Vercel's Git integration and CLI deploys were both live; the git one
  silently won each push, rebuilding with default settings. Every manual check
  passed because the clobber landed minutes *after* each verified-good deploy. The
  deeper defect it exposed was worse than the outage: the running deployment could
  not be reproduced from a clean clone, because the built handlers were gitignored
  and existed only on a laptop.
- **Every route returned `FUNCTION_INVOCATION_FAILED`**, including a zero-import
  health probe. The cause was the *root* `package.json` missing `"type": "module"`,
  found in the runtime log after guessing had failed.
- **Signup looked fine because the seeded accounts sign in fine.** It is a
  different code path, and Supabase rejects `example.com` addresses there.
- **turbo 2 defaults `envMode` to strict**, so build variables not declared in a
  task's `env` array are stripped — which produced a green pipeline and a bundle
  pointing at `localhost`. `scripts/gen-env.mjs` now fails the build instead of
  shipping that.

The honest summary: AI made the volume possible — more shipped here than three
unassisted hours would produce — and was least reliable about anything it could
not directly observe, which is exactly where the deployment defects lived.
→ [docs/process.md](docs/process.md#how-ai-was-used)

---

## Documentation

| | |
|---|---|
| [docs/architecture.md](docs/architecture.md) | State ownership, authorization, the transaction boundary, concurrency, failure handling, tests |
| [docs/deployment.md](docs/deployment.md) | What gates vs what deploys, project config, environment, and the two real defects behind both |
| [docs/application-form.md](docs/application-form.md) | The bonus form in full, including the two limitations it names — the autosave window, and unknown rolling up as green |
| [docs/process.md](docs/process.md) | Time spent, what was cut, how AI was used, what another two hours would buy |
| [docs/build-plan.md](docs/build-plan.md) | The plan written before any code — scope, domain model, screens, demo paths, cut order |
| [docs/option-2-plan.md](docs/option-2-plan.md) | A design for Option 2 proper — the four-part split, the eligibility engine, and the three defects in the bonus form it fixes |
| [docs/design-tokens.md](docs/design-tokens.md) | The design system, settled before the first component |
| [supabase/README.md](supabase/README.md) | What each migration establishes and how to replay them |

**On time spent:** the brief asks for two to three hours, and that is about the
human time this took — roughly three hours at the keyboard. Elapsed time is
longer, because Claude Code ran implementation unattended overnight; the gap is
agent time, not effort. Detail in
[docs/process.md](docs/process.md#on-time-spent).
