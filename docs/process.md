# Process notes

Time spent, what was cut, how AI was used, and what comes next. Kept separate
from the technical docs because it is about judgment rather than about the
system.

---

## On time spent

The brief asks for two to three hours, and that is roughly the human time this
took: **about three hours at the keyboard** — writing the plan, directing the
build, reviewing the domain core, and verifying claims against the live system.

Elapsed time is longer. Claude Code ran implementation unattended overnight while
I was away from the machine, so *spent* and *elapsed* are different numbers here,
and the gap between them is agent time rather than effort.

Worth stating plainly, because more shipped than three unassisted hours would
produce — notably a schema-driven application form that Option 3 does not ask
for. That surplus came from the unattended runs. Where the attended hours
actually went, in rough order: the plan and the design system, both settled
before any code; the domain core, written and reviewed directly rather than
delegated; the deployment topology, which cost more than the fifteen minutes
budgeted; and verification against the live system instead of assertion.

The core Option 3 workflow — the state machine, the transaction boundary,
authorization, concurrency and the two servicing screens — was complete and
tested before the rest. The bonus form, the migration export and some of the
failure-state polish came afterwards, and are the parts most attributable to the
overnight runs.

The original three-hour build order, written before any code, is in
[build-plan.md](build-plan.md) §25, alongside the cut order it was meant to
protect.

---

## Trade-offs and what was deliberately cut

Cut, and each would be a small, bounded addition:

- **Cancellation, request-more-info, partial approval** — one map entry, one
  guard, one button each. The map is built so that stays true.
- **Notifications, pagination, real money movement, document upload,
  multi-loan borrowers.**
- **Queue sorting** (the filter is built), **advanced empty states**, and a broad
  automated test suite — the demo paths are verified manually.

Accepted trade-offs:

- **Two Vercel projects**, the **Build Output API** the functions are emitted
  through, and **deployment belonging to Vercel's Git integration alone** — all
  three are explained in [deployment.md](deployment.md).
- **`@supabase/supabase-js` is pinned to 2.112.2**, not the latest. pnpm's
  `minimumReleaseAge` supply-chain policy rejects packages published within 24
  hours; rather than disable the policy I pinned to a version that has aged out.

### Known gaps

Stated as decisions, not omissions:

1. The 800ms autosave window described in
   [application-form.md](application-form.md).

Signup was previously blocked by Supabase's *Confirm email* setting. Rather than
route around it with a trigger that auto-confirms addresses — which weakens an
authentication control — the toggle was left for the account owner to flip. It
has been flipped, and signup now works.

---

## How AI was used

This was built with Claude Code doing the implementation throughout, directed
against a written plan.

- **Planning first.** [The build plan](build-plan.md) and
  [the design system](design-tokens.md) were settled before any code, so the
  model was implementing decisions rather than inventing them.
- **The domain core was written centrally, not delegated.** The transition map,
  guards and the transaction boundary are the assessed parts; those were written
  and reviewed directly, with 26 tests green before any UI existed.
- **Three parallel sub-agents** then built the remaining API routes, the borrower
  screens, and the lender screens against strictly disjoint file ownership and a
  precise spec. Shared primitives (status badge, timeline, the named-command
  store) were written first specifically so three agents could not invent three
  vocabularies.
- **Verification was not delegated.** Every security claim in these docs was
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
   Both are currently verified by hand against the live API — every claim in
   [architecture.md § Concurrency](architecture.md#concurrency) was checked with
   real requests, not asserted.
3. **Queue sorting and keyboard-first navigation** on the lender screen.
4. **Observability** — structured logs around every transition, which is what
   makes "why is this request stuck in review" answerable in production.

A production system would additionally need administrative provisioning, richer
audit metadata, notification workflows, rate limiting, a migration strategy and a
security review. None of those are implemented and none are claimed.
