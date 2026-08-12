import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { SessionStore } from '../core/session';

/**
 * Sign up. Deliberately plain, same as sign-in.
 *
 * This door creates borrowers and only borrowers. Role is authorization, and
 * authorization is not something a public form gets to choose — so it is stated
 * on the form rather than discovered afterwards.
 */
@Component({
  selector: 'app-sign-up',
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

      <h1 class="text-xl">Create an account</h1>
      <p class="mt-1.5 mb-6 text-base text-body">Set up access to your credit facility and release requests.</p>

      <form (ngSubmit)="submit()" class="panel p-5">
        @if (error()) {
          <div role="alert" class="mb-4 flex gap-2 border border-bad-border bg-bad-bg px-3 py-2.5">
            <span aria-hidden="true" class="font-mono text-xs leading-5 text-bad">✕</span>
            <p class="text-sm text-bad-deep">{{ error() }}</p>
          </div>
        }

        <label class="label-micro mb-1.5 block" for="full-name">Full name</label>
        <input
          id="full-name"
          name="fullName"
          type="text"
          autocomplete="name"
          required
          [(ngModel)]="fullName"
          [disabled]="pending()"
          class="mb-4 w-full border border-line-strong bg-surface px-2.5 py-2 text-base text-ink outline-none focus:border-navy disabled:bg-sunken"
        />

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
          autocomplete="new-password"
          minlength="6"
          required
          aria-describedby="password-help"
          [(ngModel)]="password"
          [disabled]="pending()"
          class="mb-1.5 w-full border border-line-strong bg-surface px-2.5 py-2 text-base text-ink outline-none focus:border-navy disabled:bg-sunken"
        />
        <p id="password-help" class="mb-5 text-sm text-muted">At least 6 characters.</p>

        <div class="mb-5 flex gap-2 border border-navy-border bg-navy-bg px-3 py-2.5">
          <span aria-hidden="true" class="font-mono text-xs leading-5 text-navy">i</span>
          <p class="text-sm text-navy-deep">
            Accounts created here are <span class="font-medium">borrower</span> accounts. Lender access is
            provisioned separately by Ridgeline servicing — what a role may approve is decided by us, not by
            a signup form.
          </p>
        </div>

        <button
          type="submit"
          [disabled]="pending()"
          class="w-full bg-navy px-3 py-2 text-base font-medium text-white transition-colors hover:bg-navy-hover disabled:opacity-50"
        >{{ pending() ? 'Creating account…' : 'Create account' }}</button>

        <p class="mt-4 text-center text-sm text-muted">
          Already registered? <a routerLink="/sign-in">Sign in</a>
        </p>
      </form>
    </div>
  `,
})
export class SignUpPage {
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);

  protected fullName = '';
  protected email = '';
  protected password = '';
  protected readonly pending = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(): Promise<void> {
    if (this.pending()) return; // the control is disabled, but never rely on that alone
    this.pending.set(true);
    this.error.set(null);

    const failure = await this.session.signUp(
      this.email.trim(),
      this.password,
      this.fullName.trim(),
    );

    this.pending.set(false);
    if (failure) {
      this.error.set(failure);
      return;
    }
    // homeRoute() reads the role the server assigned, not the one we assumed.
    await this.router.navigateByUrl(this.session.homeRoute());
  }
}
