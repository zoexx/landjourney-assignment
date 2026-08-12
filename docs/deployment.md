# Deployment

Two Vercel projects from one repository, and **exactly one system that deploys
them**. Most of what follows was learned by getting that wrong first.

---

## Two stages, owned by different systems

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
the authenticated user before doing anything and fails with `User not found`. So
the Actions route costs a credential that can deploy anything in the account, to
do a job the platform already does natively for free. The token was removed
rather than reduced, because the best-scoped secret is the one that does not
exist.

---

## Project configuration

Because both projects build from the repository root, each one's install, build
and output commands live in its **Vercel project settings** rather than in a
config file — one repository cannot hold two different root `vercel.json` files.

| Project | Build | Output |
|---|---|---|
| `landjourney-web` | `pnpm --filter web run build` | `apps/web/dist/web/browser` |
| `landjourney-api` | `node scripts/build-api.mjs` | `public` |

The root `vercel.json` carries only what is genuinely shared: the SPA rewrite,
scoped to exclude `/api` so it cannot shadow a function.

---

## Environment

Set in `.env` locally, and on both Vercel projects:

```
SUPABASE_URL=…
SUPABASE_PUBLISHABLE_KEY=…    # public by design; protected by RLS, not secrecy
API_BASE_URL=…                # web → api
WEB_ORIGIN=…                  # api CORS allow-list
```

The three **public** build values — `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`
and `API_BASE_URL` — are set as repository *variables* rather than secrets,
because none of them is secret: the publishable key is protected by RLS, not by
being hidden. `scripts/gen-env.mjs` **fails the build** when `CI=true` or
`VERCEL=1` and `API_BASE_URL` is missing, so a pipeline can no longer go green
having produced a bundle that points at `localhost`.

---

## Two defects, not two preferences

### The deployment could not be rebuilt from the repository

The more serious of the two, and a reproducibility failure rather than a
configuration choice: for a while, the live API could not be produced from a
clean clone of this repository at all.

Vercel discovers `api/**` functions from the source tree it clones, so handlers
*generated during the build* are never registered — the deployment ships with no
functions and every route 404s. The CLI hid that, because it uploads the working
directory: the built bundles existed on a laptop, were gitignored, and were
therefore part of no commit. The deployment worked, and nothing in version
control could reproduce it. A green pipeline proved nothing about what was
actually serving.

`scripts/build-api.mjs` now esbuild-bundles each handler into
`.vercel/output/functions/**.func` with an explicit route table — Vercel's Build
Output API, which is the contract for *the build produces the functions*. The
same commit deploys identically from a laptop, from CI, or from Vercel's own
builder.

### Two deploy paths is the failure mode

Not one path or the other — *two*. An earlier revision had Vercel's Git
integration connected **and** CLI deploys running from Actions. Every push
silently rebuilt both projects with default settings, so the API deployed with no
functions at all and the production alias was reassigned to it. Every route
returned 404 for about forty minutes while the CLI deploys appeared to succeed.

What made it dangerous was not the 404 but the schedule: the clobbering happened
on push, minutes after a verified-good deploy, so every manual check passed and
the service broke afterwards. Whichever system deploys, exactly one system
deploys. Deployment now belongs to Vercel's Git integration alone; Actions gates
and does not deploy.

---

## Accepted cost

**Two Vercel projects** cost CORS configuration and a second env set. Chosen
deliberately for the deployment separation between the client bundle and the
functions that own the workflow.
