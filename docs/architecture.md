# Architecture

How state is owned, how a transition commits, and what happens when two of them
race. The summary of each section is in the [README](../README.md); this is the
evidence behind it.

- [Where state lives](#where-state-lives)
- [Authorization — three independent layers](#authorization--three-independent-layers)
- [The transaction boundary](#the-transaction-boundary)
- [Concurrency](#concurrency)
- [Failure handling](#failure-handling)
- [Tests](#tests)

---

## Layout

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

## Where state lives

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
moves a status or a balance is `commit_transition()`. A `PATCH` straight to
PostgREST with `{"status":"approved"}` updates **zero rows** — verified, not
assumed.

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

**Cross-request contention.** Version checks alone are not enough. Verified end
to end against the live API: two $40,000 requests were both approved against
$60,000 of headroom (the balance did not move — approval reserves nothing), the
first funded to a balance of $80,000, and the second was refused with
`guard_failed` and *"Available credit has changed since this request was
approved."* The balance was unchanged by the refusal and the second request
stayed `approved` rather than being corrupted into a half-state.

Given $60,000 available and two approved $40,000 requests, both were legitimately
approvable — approval does not reserve credit. Funding therefore re-checks the
**loan aggregate** at funding time, inside the same transaction that moves the
money. The second request is refused with a domain conflict rather than producing
an impossible balance. `balance <= credit_limit` is also a CHECK constraint, so
the invariant holds even if every layer above it were wrong.

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
carries a glyph and a word. See [design-tokens.md](design-tokens.md).

---

## Tests

26 domain tests in `packages/contracts`, targeting invariants rather than
coverage:

- every legal transition
- `submitted → funded` refused, `declined → funded` refused, `funded` terminal
- borrower-cannot-approve, decline-requires-reason
- the fast track refused for credit releases and for amber files
- funding to the exact limit allowed, one cent beyond refused
- the two-competing-requests case

```bash
pnpm run test
```
