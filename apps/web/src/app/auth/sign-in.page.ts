import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { SessionStore } from '../core/session';

/**
 * Sign in. Deliberately plain — the brief spends its design budget on the
 * servicing screens, not here.
 */
@Component({
  selector: 'app-sign-in',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink],
  template: `
    <div class="mx-auto flex min-h-screen max-w-[26rem] flex-col justify-center px-6 py-16">
      <div class="mb-7 flex items-center gap-2.5">
        <span aria-hidden="true" class="grid h-7 w-7 place-items-center bg-navy text-xs font-semibold text-white">R</span>
        <div>
          <div class="text-lg font-semibold tracking-[-0.01em] text-ink">Ridgeline</div>
          <div class="label-micro">Agricultural Finance</div>
        </div>
      </div>

      <h1 class="text-xl">Sign in</h1>
      <p class="mt-1.5 mb-6 text-base text-body">Access your credit facility and release requests.</p>

      <form (ngSubmit)="submit()" class="panel p-5">
        @if (error()) {
          <div role="alert" class="mb-4 flex gap-2 border border-bad-border bg-bad-bg px-3 py-2.5">
            <span aria-hidden="true" class="font-mono text-xs leading-5 text-bad">✕</span>
            <p class="text-sm text-bad-deep">{{ error() }}</p>
          </div>
        }

        <label class="label-micro mb-1.5 block" for="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autocomplete="email"
          required
          [(ngModel)]="email"
          [disabled]="pending()"
          class="mb-4 w-full border border-line-strong bg-surface px-2.5 py-2 text-base text-ink outline-none focus:border-navy disabled:bg-sunken"
        />

        <label class="label-micro mb-1.5 block" for="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
          [(ngModel)]="password"
          [disabled]="pending()"
          class="mb-5 w-full border border-line-strong bg-surface px-2.5 py-2 text-base text-ink outline-none focus:border-navy disabled:bg-sunken"
        />

        <button
          type="submit"
          [disabled]="pending()"
          class="w-full bg-navy px-3 py-2 text-base font-medium text-white transition-colors hover:bg-navy-hover disabled:opacity-50"
        >{{ pending() ? 'Signing in…' : 'Sign in' }}</button>

        <p class="mt-4 text-center text-sm text-muted">
          New borrower? <a routerLink="/sign-up">Create an account</a>
        </p>
      </form>

      <div class="panel mt-4 p-4">
        <div class="label-micro mb-2.5">Demo accounts</div>
        <div class="space-y-2">
          @for (demo of demos; track demo.email) {
            <button
              type="button"
              (click)="use(demo)"
              class="flex w-full items-baseline justify-between gap-3 border border-line bg-raised px-2.5 py-1.5 text-left transition-colors hover:border-navy-border hover:bg-navy-bg"
            >
              <span class="numeric text-sm text-ink">{{ demo.email }}</span>
              <span class="label-micro shrink-0">{{ demo.role }}</span>
            </button>
          }
        </div>
        <p class="mt-2.5 text-sm text-muted">Select an account to fill the form.</p>
      </div>
    </div>
  `,
})
export class SignInPage {
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);

  protected email = '';
  protected password = '';
  protected readonly pending = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly demos = [
    { email: 'borrower@example.com', password: 'DemoBorrower2026', role: 'Borrower' },
    { email: 'lender@example.com', password: 'DemoLender2026', role: 'Lender' },
  ];

  protected use(demo: { email: string; password: string }): void {
    this.email = demo.email;
    this.password = demo.password;
  }

  protected async submit(): Promise<void> {
    if (this.pending()) return; // the control is disabled, but never rely on that alone
    this.pending.set(true);
    this.error.set(null);

    const failure = await this.session.signIn(this.email.trim(), this.password);

    this.pending.set(false);
    if (failure) {
      this.error.set(failure);
      return;
    }
    await this.router.navigateByUrl(this.session.homeRoute());
  }
}
