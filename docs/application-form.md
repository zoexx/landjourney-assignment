# The bonus: a schema-driven application form

Built and live. The form is **lender-defined data, not markup**: a `form_schemas`
row holds `steps` and `rules` as JSONB, and Angular renders it at runtime.

- **Four field types** — `text`, `number`, `select`, `textarea` — and the
  renderer switches on `field.type` and nothing else. No code anywhere branches
  on a field *key*. Adding a field is a data change.

- **Validators are derived from the schema**, never written per field.
  `validatePayload()` runs client-side for live messages and server-side at the
  `draft → submitted` boundary — one definition, two consumers, so they cannot
  drift. Untouched fields are not shouted at until a submit is attempted.

- **Autosave to Postgres.** Edits debounce 800ms then
  `PATCH /api/requests/:id/draft` with `{ payload, step }`. Not localStorage, not
  component state. The step is saved alongside the values and flushed immediately
  on step change.

- **Resume.** A hard refresh mid-form returns to the same step with values
  intact — verified live: refreshed on step 2, came back on step 2 with the
  entered values restored and eligibility recomputed from the persisted payload.

- **Eligibility is evaluated in both runtimes.** The same pure evaluator runs
  client-side on every keystroke for the live panel (no network call per
  keystroke) and again **server-side** in the draft endpoint, which persists the
  verdict. Confirmed in the database: the row carried `eligibility.level` written
  by the server, not by the browser. A rule only appears once the questions it
  reads are answered, so a half-filled form does not read as a rejection — but
  *not yet evaluated* is not a pass either, and the engine cannot currently say
  the difference. That is the second limitation below.

- **Eligibility gates legality.** A green application may be approved straight
  from `submitted`; anything amber or red must route through `under_review`. That
  is the `eligibility_green` guard in the transition map, not a UI rule.

---

## Two honest limitations

### The autosave debounce loses the last keystroke

The autosave debounce means a keystroke made in the last 800ms before a hard
refresh can be lost. Everything older is durable. A `beforeunload` flush would
narrow the window but not close it; the real fix is optimistic local buffering
reconciled on load, which was out of scope here. The step marker and all settled
values survive, which is what the durability claim rests on.

### Unknown rolls up as green, and green is what the fast track requires

Three states matter to a borrower filling this form, and the engine only models
two of them:

| | Meaning | What it should do |
|---|---|---|
| **within policy** | asked, answered, inside the threshold | green |
| **outside policy** | asked, answered, outside the threshold | amber or red |
| **not yet evaluated** | not asked yet, or answered blank | *neither* — and today it silently becomes green |

`evaluateEligibility` skips any rule whose inputs resolve to `null`
(`eligibility.ts`), and `rollUp` seeds its reduction at `green`, so a rule with
absent inputs contributes no outcome and an empty outcome list rolls up green.
Two consequences, one cosmetic and one not:

- **The panel shows the green badge on an untouched form**, beside copy reading
  "Nothing to assess yet." The words are right and the badge is wrong: it states
  *within policy* where it means *nothing asked yet*.

- **`eligibility_green` is the fast-track guard** — the one that lets an
  application go from `submitted` straight to `approved`, skipping
  `under_review`. So absence of evidence is currently evidence of eligibility.
  It does not fire today: every rule in the seeded schema
  (`acreage`, `yearsOps`, `amount / annualRevenue`) reads a field marked
  `required`, and submit refuses a payload missing any required field, so a
  submitted application is always fully evaluated. But nothing *enforces* that
  link. Write a rule over an optional field — `existingDebt` is already one — or
  drop `required` from a field in a new form version, and an unanswered question
  becomes a pass on the fast path, with no error anywhere.

The fix is a fourth level rather than a patch to the skip: `incomplete`, ranked
**above** amber in the roll-up, because not knowing must never present as milder
than knowing something mildly bad — that inversion is the whole defect. Each
rule then declares `onMissing` explicitly instead of dropping out silently.
`eligibility_green` needs no change and becomes correct on its own terms: an
unanswered file is `incomplete`, not `green`. Designed out in
[option-2-plan.md](option-2-plan.md#5-part-3--eligibility-rules-and-engine).
