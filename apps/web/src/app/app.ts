import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { SessionStore } from './core/session';

/**
 * Application shell.
 *
 * The masthead names the institution and the signed-in actor's role, because in
 * a two-role product "which hat am I wearing" is the single most important piece
 * of ambient context.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <a class="skip-link" href="#main">Skip to content</a>

    @if (session.signedIn()) {
      <header class="border-b border-line bg-surface">
        <div class="mx-auto flex h-14 max-w-[1400px] items-center gap-6 px-6">
          <div class="flex items-center gap-2.5">
            <span aria-hidden="true" class="grid h-6 w-6 place-items-center bg-navy text-[11px] font-semibold text-white">R</span>
            <span class="text-md font-semibold tracking-[-0.01em] text-ink">Ridgeline</span>
            <span class="label-micro !text-[9px]">Agricultural Finance</span>
          </div>

          <nav aria-label="Primary" class="flex items-center gap-1">
            @for (item of nav(); track item.path) {
              <a
                [routerLink]="item.path"
                routerLinkActive="!text-ink !border-navy"
                [routerLinkActiveOptions]="{ exact: false }"
                class="border-b-2 border-transparent px-3 py-[1.05rem] text-sm font-medium text-muted transition-colors hover:text-ink"
              >{{ item.label }}</a>
            }
          </nav>

          <div class="ml-auto flex items-center gap-4">
            <div class="text-right leading-tight">
              <div class="text-sm font-medium text-ink">{{ session.displayName() }}</div>
              <div class="label-micro">{{ roleLabel() }}</div>
            </div>
            <button
              type="button"
              (click)="signOut()"
              class="border border-line-strong bg-surface px-2.5 py-1 text-sm font-medium text-body transition-colors hover:bg-sunken hover:text-ink"
            >Sign out</button>
          </div>
        </div>
      </header>
    }

    <main id="main" tabindex="-1">
      <router-outlet />
    </main>
  `,
  styles: [
    `
      :host {
        display: block;
        min-height: 100vh;
      }
      /* Visible only when focused — keyboard users get a way past the masthead. */
      .skip-link {
        position: absolute;
        left: -9999px;
        z-index: 50;
        padding: 0.5rem 0.75rem;
        background: var(--color-surface);
        border: 1px solid var(--color-navy);
        font-size: var(--text-sm);
      }
      .skip-link:focus {
        left: 0.5rem;
        top: 0.5rem;
      }
      #main:focus {
        outline: none;
      }
    `,
  ],
})
export class App {
  protected readonly session = inject(SessionStore);

  protected readonly roleLabel = computed(() =>
    this.session.isLender() ? 'Lender · servicing' : 'Borrower',
  );

  protected readonly nav = computed(() =>
    this.session.isLender()
      ? [{ path: '/queue', label: 'Review queue' }]
      : [{ path: '/my-file', label: 'My file' }],
  );

  protected signOut(): void {
    void this.session.signOut();
  }
}
