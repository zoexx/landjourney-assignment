import type { Routes } from '@angular/router';
import { redirectIfSignedIn, requireAuth, requireBorrower, requireLender } from './core/guards';

/**
 * Every screen is lazily loaded, so the lender bundle is not shipped to a
 * borrower and vice versa.
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'my-file' },

  {
    path: 'sign-in',
    canActivate: [redirectIfSignedIn],
    loadComponent: () => import('./auth/sign-in.page').then((m) => m.SignInPage),
  },
  {
    path: 'sign-up',
    canActivate: [redirectIfSignedIn],
    loadComponent: () => import('./auth/sign-up.page').then((m) => m.SignUpPage),
  },

  {
    path: 'my-file',
    canActivate: [requireBorrower],
    loadComponent: () => import('./borrower/my-file.page').then((m) => m.MyFilePage),
  },
  {
    path: 'apply/:id',
    canActivate: [requireBorrower],
    loadComponent: () => import('./borrower/application.page').then((m) => m.ApplicationPage),
  },

  {
    path: 'queue',
    canActivate: [requireLender],
    loadComponent: () => import('./lender/queue.page').then((m) => m.QueuePage),
  },

  {
    path: 'requests/:id',
    canActivate: [requireAuth],
    loadComponent: () => import('./shared/request-detail.page').then((m) => m.RequestDetailPage),
  },

  { path: '**', redirectTo: 'my-file' },
];
