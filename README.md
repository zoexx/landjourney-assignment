# Ridgeline — agricultural lending servicing portal

**Option 3.** An existing borrower draws against an established credit facility;
a lender reviews, approves and releases the funds.

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
| `borrower@example.com` | `DemoBorrower2026` | A $100,000 facility, $40,000 drawn — **$60,000 available** — one funded release and one awaiting a decision |
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

---

## Documentation

| | |
|---|---|
| [docs/architecture.md](docs/architecture.md) | State ownership, authorization, the transaction boundary, concurrency, failure handling, tests |
| [docs/deployment.md](docs/deployment.md) | What gates vs what deploys, project config, environment, and the two real defects behind both |
| [docs/application-form.md](docs/application-form.md) | The bonus form in full, including its one honest limitation |
| [docs/process.md](docs/process.md) | Time spent, what was cut, how AI was used, what another two hours would buy |
| [docs/build-plan.md](docs/build-plan.md) | The plan written before any code — scope, domain model, screens, demo paths, cut order |
| [docs/design-tokens.md](docs/design-tokens.md) | The design system, settled before the first component |
| [supabase/README.md](supabase/README.md) | What each migration establishes and how to replay them |

**On time spent:** the brief asks for two to three hours, and that is about the
human time this took — roughly three hours at the keyboard. Elapsed time is
longer, because Claude Code ran implementation unattended overnight; the gap is
agent time, not effort. Detail in
[docs/process.md](docs/process.md#on-time-spent).
