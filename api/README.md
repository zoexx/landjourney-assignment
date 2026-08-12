# Deployment shims

Vercel discovers serverless functions at `<deployment root>/api/**`. The Vercel
CLI cannot set a project's Root Directory non-interactively, so both projects
deploy from the repository root and this directory re-exports the real handlers.

The implementation lives in `apps/api/` — these files are one line each and hold
no logic. If you set Root Directory to `apps/api` in the Vercel dashboard, this
directory can be deleted and nothing else changes.
