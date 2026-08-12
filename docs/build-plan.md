# Agricultural lending portal — revised build plan

**Declared answer: Option 3 — servicing portal with credit release requests.**

The submission should demonstrate one thing exceptionally well:

> **The UI is a projection of a reliable business workflow, not the owner of that workflow.**

The application should remain deliberately small. Depth goes into workflow correctness, persistence, authorization, concurrency, failure handling, and role-specific UX rather than feature count.

---

## 1. Fixed parameters

- Turborepo monorepo
- Angular 22, standalone APIs + Signals
- Supabase Auth
- Supabase Postgres
- Node API/serverless functions
- Vercel live deployment
- GitHub Actions: install, lint, build, deploy
- Workflow modelled explicitly in application code
- No workflow engine
- Hard stop at 3 hours

If time runs out, submit a smaller coherent workflow rather than an unfinished broader product.

---

# 2. Scope

## Build

### Borrower

- Sign in / sign up
- View existing loan
- View:
  - balance
  - credit limit
  - derived available credit

- Submit a credit release request
- View current request status
- View request timeline/history
- Refresh at any point without losing workflow state

### Lender

- Sign in with seeded lender account
- View request queue
- Open request detail
- Start review
- Approve
- Decline with required reason
- Mark approved request as funded
- See stale-state/conflict feedback

## Do not build

- Dynamic loan application form
- Generic eligibility rule engine
- Application autosave
- Document upload
- Real money movement
- Notifications
- Pagination
- Multiple loan types
- Partial approvals
- Request-more-information flow
- Cancellation
- Full design system
- Comprehensive automated test suite

These can be named as natural extensions in the README.

---

# 3. Domain model

There are two actors operating on the same domain data.

|             | Borrower                                 | Lender                      |
| ----------- | ---------------------------------------- | --------------------------- |
| Sees        | Own loan, own requests, own history      | Requests across borrowers   |
| Creates     | Credit release request                   | Nothing                     |
| Moves state | Creation only                            | Review transitions          |
| Cannot      | Review/approve/fund; see other borrowers | Create request for borrower |
| Role source | `profiles` table                         | Seeded/provisioned account  |

Roles always come from trusted server/database state, never from a browser-supplied role.

---

# 4. Workflow

A credit release request has one explicit lifecycle:

```text
submitted
    ↓
under_review
   ↙       ↘
declined   approved
               ↓
             funded
```

Terminal states:

```text
declined
funded
```

## Transition table

| From           | To             | Actor    | Guard                                     | Effect                               |
| -------------- | -------------- | -------- | ----------------------------------------- | ------------------------------------ |
| —              | `submitted`    | borrower | `0 < amount <= availableCredit`           | create request + creation event      |
| `submitted`    | `under_review` | lender   | —                                         | append event                         |
| `under_review` | `approved`     | lender   | request amount still potentially fundable | append event                         |
| `under_review` | `declined`     | lender   | non-empty reason                          | append event                         |
| `approved`     | `funded`       | lender   | sufficient credit **at funding time**     | increase loan balance + append event |

Anything not in the transition map is illegal.

Examples:

```text
submitted → funded       illegal
declined → approved      illegal
declined → funded        illegal
funded → anything        illegal
```

Invalid transitions return `409 Conflict`.

Unauthorized actor actions return `403 Forbidden`.

---

# 5. Domain API: commands, not status mutation

Angular never sends:

```json
{ "status": "approved" }
```

as arbitrary record mutation.

The client exposes domain-language commands:

```ts
startReview();
approve();
decline(reason);
markFunded();
```

They call:

```text
POST /api/requests/:id/transition
```

with:

```ts
{
  to: RequestStatus;
  expectedVersion: number;
  note?: string;
}
```

The server:

1. authenticates the actor
2. resolves role
3. loads the current request
4. checks expected version
5. finds the transition
6. checks actor permission
7. checks transition guard
8. commits transition atomically
9. returns authoritative state

There is no other request-status mutation path.

---

# 6. Transaction boundary — P0

A workflow transition must not partially succeed.

The following belong to **one atomic commit**:

```text
request status update
+
request version increment
+
domain side effect
+
request event append
```

For funding:

```text
BEGIN

verify request still approved
verify expectedVersion
verify loan still has enough available credit

increase loan balance
set request → funded
increment request version
append funded event

COMMIT
```

If any step fails, none of them are committed.

The state-machine decision remains in Node/application code.

A narrow Postgres transaction/RPC may be used for atomic persistence. It does not own the workflow definition; it guarantees that an already-authorized transition commits consistently.

---

# 7. Loan accounting

Do not independently mutate both balance and available credit.

Persist:

```text
credit_limit
balance
```

Derive:

```text
availableCredit = creditLimit - balance
```

Invariant:

```text
0 <= balance <= creditLimit
```

Example:

```text
credit limit     $100,000
balance           $40,000
available credit  $60,000
```

Fund a `$25,000` release:

```text
balance           $65,000
available credit  $35,000
```

Funding must atomically ensure:

```text
availableCredit >= request.amount
```

at the time funds are released.

Approval does not reserve credit.

---

# 8. Cross-request concurrency

Request-version concurrency alone is not enough.

Example:

```text
Loan available credit = $60k

Request A = $40k
Request B = $40k
```

Both could independently be approved.

Only one can successfully fund if the other consumes the available credit first.

Therefore the funding transaction must check the **loan aggregate**, not only the request version.

A failed funding attempt because another request consumed the available credit should return a domain conflict rather than create an invalid balance.

UI:

> Available credit changed while this request was open. The latest loan information has been loaded.

---

# 9. Optimistic concurrency

Each request has:

```text
version
```

Every transition sends:

```text
expectedVersion
```

Example:

```text
Lender A                  Lender B
version 4                 version 4

Approve
→ version 5

                          Decline
                          expectedVersion 4
                          → 409 stale
```

The second action is rejected.

Angular then refetches the authoritative request.

Do not blindly retry workflow commands.

---

# 10. Idempotency

Full command idempotency is not required for the three-hour prototype.

The endpoint should leave room for:

```text
commandId
```

Production implementation:

```text
(request_id, command_id) UNIQUE
```

A retried command with the same ID would return the existing result instead of performing the business operation twice.

Prototype protection:

- disable action while pending
- do not allow double-click command dispatch
- no optimistic business-state transition

Document the production idempotency approach in README.

---

# 11. Persistence and server/client state

## Server state

Authoritative and refresh-safe:

- request status
- amount
- loan
- balance
- credit limit
- request version
- timestamps
- decline reason
- event history

## Client state

Ephemeral:

- loading
- selected request
- form input before submission
- pending command
- error message
- filters
- derived presentation

Angular Signals represent reactive UI state.

They do **not** own workflow truth.

Use `computed()` for:

- available actions
- human-readable status
- available credit
- timeline presentation
- filtered queue

Use `effect()` only for genuine side effects.

---

# 12. Authorization and RLS

Security exists at two independent boundaries.

## API

The API verifies:

- authenticated user
- actor role
- ownership
- legal transition
- transition guard

## Postgres / Supabase RLS

Borrower:

```text
borrower_id = auth.uid()
```

may read only their own:

- loans
- requests
- request events

Lender may read servicing data across borrowers.

The API should operate using the authenticated user's Supabase context rather than casually bypassing RLS with a service-role client.

The browser must not have an alternative direct path that allows request status mutation outside the transition API.

**UI role checks are convenience, not authorization.**

---

# 13. Authentication

Supabase Auth:

- email/password signup
- email/password login
- persisted session
- auto refresh
- bearer JWT sent to API

Signup always creates:

```text
role = borrower
```

Lender role is provisioned, never self-selected.

Seed:

```text
lender@example.com
borrower@example.com
```

The borrower account starts with:

- one active loan
- one completed request/history
- enough available credit to demonstrate a new release

Put credentials in README.

---

# 14. Data model

```sql
profiles
  id
  role
  full_name

loans
  id
  borrower_id
  credit_limit
  balance
  currency
  created_at
  updated_at

requests
  id
  borrower_id
  loan_id
  amount
  status
  decline_note
  version
  created_at
  updated_at

request_events
  id
  request_id
  from_status nullable
  to_status
  actor_id
  actor_role
  note
  created_at
```

Money:

```text
integer cents
```

Currency:

```text
CAD
```

Do not store `available_credit`; derive it.

---

# 15. Database constraints

Add cheap invariants at the database layer.

Examples:

```text
credit_limit >= 0
balance >= 0
balance <= credit_limit
request.amount > 0
request.version >= 1
request.loan_id NOT NULL
```

Foreign keys:

```text
loan.borrower_id → profiles.id
request.borrower_id → profiles.id
request.loan_id → loans.id
event.request_id → requests.id
```

Useful indexes:

```text
requests(borrower_id)
requests(status, created_at)
request_events(request_id, created_at)
loans(borrower_id)
```

Application code owns workflow legality; the database still protects basic structural truth.

---

# 16. Event history

`request_events` is append-only.

Creation itself is an event:

```text
NULL → submitted
```

Example history:

```text
Submitted
Aug 11 · 10:31
Borrower requested $25,000

Under review
Aug 11 · 10:42
Review started

Approved
Aug 11 · 11:04
Approved by lender

Funded
Aug 11 · 11:26
Funds released
```

Never reconstruct history from current status.

The timeline is domain data.

---

# 17. Screens

## 1. Authentication

Minimal.

- login
- signup
- demo-account hint

Do not spend design time here.

---

## 2. Borrower — My Loan

Primary servicing screen.

Show:

```text
Loan balance
Credit limit
Available credit
```

Then:

```text
Credit release requests
```

Each request shows:

- amount
- status
- date
- clear explanatory copy

Primary action:

```text
Request credit release
```

---

## 3. Credit Release Form

Keep it intentionally small.

Fields:

```text
Amount
Purpose
Optional note
```

Validation:

```text
amount > 0
amount <= currently available credit
```

Submitting creates:

```text
NULL → submitted
```

persisted immediately.

No complex eligibility engine.

---

## 4. Request Detail — Borrower

Show:

- requested amount
- current status
- borrower-facing explanation
- event timeline
- decline reason where relevant

Borrower actions after submission:

```text
none
```

The page answers:

> Where is my request, and what happens next?

---

## 5. Lender Queue

This is the most information-dense screen.

Show:

```text
Borrower
Amount
Submitted
Current status
Loan available credit
```

Allow:

- status filter
- row navigation

Sorting is optional and cut first if time is short.

Design loading, empty, and error states.

---

## 6. Lender Review Detail

Show:

- borrower
- request amount
- purpose/note
- loan balance
- credit limit
- available credit
- current status
- history

Only legal actions appear.

Example:

```text
submitted
→ Start review

under_review
→ Decline
→ Approve

approved
→ Mark funded

declined / funded
→ no actions
```

Actions come from the transition map rather than hard-coded state checks scattered through components.

---

# 18. Status language

Do not expose enums as product copy.

### Submitted

**Submitted**

Your credit release request has been received and is waiting for review.

### Under review

**Under review**

Your lender is reviewing this request. Nothing is required from you right now.

### Approved

**Approved**

Your request has been approved and is waiting for funds to be released.

### Funded

**Funded**

The credit release has been completed.

### Declined

**Declined**

The request was not approved.

Show the lender's reason below.

Status color is semantic and must never be the only signal.

---

# 19. Failure UX

Explicitly support:

### Loading

Never briefly display an invented/default status.

### Transition pending

Disable relevant controls.

Display progress.

### Generic transition failure

Keep current displayed status unchanged.

Explain that the action did not complete.

### Stale version

```text
This request changed while you were viewing it.
We've loaded the latest state.
```

Refetch.

### Insufficient credit at funding

```text
Available credit has changed since this request was approved.
Review the updated loan balance before continuing.
```

Refetch both request and loan.

### Network uncertainty

Do not optimistically claim a business transition succeeded.

Fetch authoritative state.

---

# 20. Angular structure

```text
apps/web
  auth/
  borrower/
  lender/
  requests/
  shared/

apps/api
  auth/
  requests/
  persistence/

packages/contracts
  request.types.ts
  transitions.ts
  schemas.ts

packages/config
```

`packages/contracts` owns:

- status types
- role types
- transition definition
- request DTOs
- Zod/API schemas

Do not put database persistence into the contracts package.

Do not let components own:

```text
persistence + workflow + presentation
```

at the same time.

---

# 21. UI system

Use an existing Angular component library for primitives to save time.

Visual direction:

```text
quiet institutional finance
calm
precise
trustworthy
operational
information-first
```

Avoid:

- gradients
- decorative charts
- glassmorphism
- giant metric cards
- excessive rounded rectangles

Prioritize:

- data rows
- status badge
- timeline
- request table
- action panel
- alerts
- clear loading/error states

The lender screen should be denser than the borrower experience while sharing the same visual vocabulary.

---

# 22. Automated tests

Do not chase coverage percentage.

Write a handful of high-value domain tests.

### Must have

```text
submitted → under_review        allowed for lender
under_review → approved         allowed for lender
under_review → declined         requires reason
approved → funded               allowed
submitted → funded              rejected
declined → funded               rejected
borrower → approve              rejected
```

If inexpensive, add:

```text
stale expectedVersion → conflict
```

The rest is verified via the demo script.

---

# 23. Invariants

These matter more than feature count.

- A declined request can never become funded.
- A funded request is terminal.
- A borrower cannot perform lender transitions.
- A borrower cannot see another borrower's servicing data.
- Every visible action corresponds to a legal transition.
- Workflow state survives refresh.
- History and current state are committed together.
- Funding and the loan balance update are committed together.
- Loan balance can never exceed the credit limit.
- Two requests cannot both consume the same available credit.
- A stale lender action cannot silently overwrite a newer state.
- Failed commands never make the UI pretend the transition succeeded.

---

# 24. Demo paths

## HP1 — Normal credit release

Borrower:

```text
login
→ loan available credit $60k
→ request $25k
→ submitted
```

Lender:

```text
queue
→ open request
→ start review
→ approve
→ fund
```

Borrower refreshes:

```text
balance $65k
available credit $35k
status funded
timeline complete
```

---

## HP2 — Decline

Borrower requests release.

Lender:

```text
start review
→ decline
```

Empty decline reason:

```text
rejected
```

Non-empty reason:

```text
accepted
```

Borrower sees reason.

Attempt:

```text
declined → funded
```

returns conflict.

---

## HP3 — Stale lender

Open same request in two lender tabs.

Both see:

```text
version 3
under_review
```

Tab A:

```text
Approve
```

Request becomes version 4.

Tab B:

```text
Decline
expectedVersion 3
```

returns stale `409`.

UI refetches and shows approved state.

---

## HP4 — Competing credit releases

Loan:

```text
available = $60k
```

Two approved requests:

```text
A = $40k
B = $40k
```

Fund A.

Loan now:

```text
available = $20k
```

Attempt to fund B:

```text
rejected because current available credit is insufficient
```

No negative/invalid loan balance is possible.

This is the highest-value robustness demo.

---

## HP5 — Refresh

At:

```text
submitted
under_review
approved
funded
declined
```

hard refresh.

The same authoritative state returns every time.

---

# 25. Three-hour build order

## 0:00–0:20 — Scaffold

- Turborepo
- Angular
- API
- shared contracts
- GitHub
- Vercel projects
- CI
- prove empty deployment works

Do infrastructure first so deployment cannot surprise the final ten minutes.

---

## 0:20–0:45 — Auth + data

- Supabase Auth
- profiles
- loans
- requests
- request_events
- RLS
- DB constraints
- seed lender + borrower
- verify seeded login
- verify borrower isolation

---

## 0:45–1:25 — Workflow core

Highest priority.

Build:

- transition map
- actor guards
- domain guards
- request version
- event writing
- atomic transition persistence
- funding effect
- available-credit invariant
- 409 stale handling

Add transition unit tests while implementing.

At **1:25**, the domain must already be demonstrably correct through API calls even if the UI is ugly.

---

## 1:25–1:50 — Borrower servicing flow

Build:

- My Loan
- balance / credit limit / available credit
- credit-release form
- request list
- request detail
- timeline
- refresh persistence

---

## 1:50–2:25 — Lender workflow

Build:

- queue
- review detail
- legal action panel
- start review
- approve
- decline
- fund
- pending states
- stale conflict UX

This is the primary frontend demonstration.

---

## 2:25–2:40 — Robustness pass

Manually verify:

- two lender tabs
- duplicate action protection
- insufficient credit at funding
- borrower authorization
- failed action UX
- hard refresh

Fix correctness issues before visual polish.

---

## 2:40–3:00 — README + final verification

README:

- option selected
- architecture
- state machine
- source of truth
- role model
- transaction boundary
- optimistic concurrency
- idempotency production note
- RLS/auth boundary
- trade-offs
- what was deliberately cut
- AI usage
- what another two hours would buy

Clean-browser smoke test.

Stop at 3:00.

---

# 26. Cut order

If behind schedule:

### Cut first

- queue sorting
- fancy filtering
- visual polish
- purpose field
- signup styling

### Cut second

- advanced empty states
- extra automated tests
- additional seeded scenarios

### Never cut

- explicit state machine
- credit release
- borrower/lender distinction
- authorization
- persistence across refresh
- atomic funded transition
- event history
- stale-version protection

A visually plain but correct workflow is better than a polished system whose state can become inconsistent.

---

# 27. Pre-submit verification

- [ ] Seeded borrower login works.
- [ ] Seeded lender login works.
- [ ] Fresh signup creates only borrower role.
- [ ] Borrower cannot see another borrower's request.
- [ ] Borrower cannot call lender transition.
- [ ] Submitted request survives refresh.
- [ ] `submitted → funded` is rejected.
- [ ] Decline without reason is rejected.
- [ ] `declined → funded` is rejected.
- [ ] Stale `expectedVersion` returns 409.
- [ ] UI refetches after stale conflict.
- [ ] Double-click cannot dispatch two commands.
- [ ] Funding updates loan balance and request state atomically.
- [ ] Funding cannot exceed current available credit.
- [ ] Event history matches committed state.
- [ ] Live URL works in clean browser profile.
- [ ] README demo credentials are correct.

---

# 28. Production considerations — document, don't build

A production system would additionally require:

- true idempotency keys
- stronger transactional command infrastructure
- richer audit metadata
- administrative provisioning
- notification workflows
- observability
- more granular lender permissions
- cancellation / information-request transitions
- reservation of approved credit if required by business policy
- comprehensive integration/E2E tests
- database migration strategy
- rate limiting
- security review

Do not claim these are implemented.

---

# Final implementation rule

When deciding between:

> another feature

and:

> proving that a business invariant survives failure, concurrency, refresh, or a malicious request

choose the invariant.

The finished app should make this obvious:

> **The workflow remains correct even when the UI is stale, the user refreshes, two reviewers disagree, or two requests compete for the same credit.**
