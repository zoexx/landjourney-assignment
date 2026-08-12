/**
 * Route guards.
 *
 * These are convenience, not authorization. Every one of them exists to avoid
 * showing someone a screen that would fail anyway — the actual boundary is RLS
 * in Postgres and the actor check in the API. Nothing here is load-bearing for
 * security, and none of it is trusted by the server.
 */
import { inject } from '@angular/core';
import { Router, type CanActivateFn, type UrlTree } from '@angular/router';
import { SessionStore } from './session';

/** Wait for the persisted session to be restored before deciding anything. */
async function settled(session: SessionStore): Promise<void> {
  if (!session.restoring()) return;
  await new Promise<void>((resolve) => {
    const tick = () => (session.restoring() ? setTimeout(tick, 10) : resolve());
    tick();
  });
}

/**
 * Shared precondition. Kept as a plain function rather than a `CanActivateFn` so
 * the role guards below can compose it and still return a narrow type.
 */
async function ensureSignedIn(
  session: SessionStore,
  router: Router,
  returnTo: string,
): Promise<true | UrlTree> {
  await settled(session);
  if (session.signedIn()) return true;
  return router.createUrlTree(['/sign-in'], { queryParams: { next: returnTo } });
}

export const requireAuth: CanActivateFn = (_route, state) =>
  ensureSignedIn(inject(SessionStore), inject(Router), state.url);

export const requireLender: CanActivateFn = async (_route, state) => {
  const session = inject(SessionStore);
  const router = inject(Router);
  const authed = await ensureSignedIn(session, router, state.url);
  if (authed !== true) return authed;
  return session.isLender() ? true : router.createUrlTree(['/my-file']);
};

export const requireBorrower: CanActivateFn = async (_route, state) => {
  const session = inject(SessionStore);
  const router = inject(Router);
  const authed = await ensureSignedIn(session, router, state.url);
  if (authed !== true) return authed;
  return session.isLender() ? router.createUrlTree(['/queue']) : true;
};

/** Send an already-signed-in visitor to wherever their role belongs. */
export const redirectIfSignedIn: CanActivateFn = async () => {
  const session = inject(SessionStore);
  const router = inject(Router);
  await settled(session);
  return session.signedIn() ? router.createUrlTree([session.homeRoute()]) : true;
};
