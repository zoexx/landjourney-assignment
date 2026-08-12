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
  reads are answered, so a half-filled form does not read as a rejection.

- **Eligibility gates legality.** A green application may be approved straight
  from `submitted`; anything amber or red must route through `under_review`. That
  is the `eligibility_green` guard in the transition map, not a UI rule.

---

## One honest limitation

The autosave debounce means a keystroke made in the last 800ms before a hard
refresh can be lost. Everything older is durable. A `beforeunload` flush would
narrow the window but not close it; the real fix is optimistic local buffering
reconciled on load, which was out of scope here. The step marker and all settled
values survive, which is what the durability claim rests on.
