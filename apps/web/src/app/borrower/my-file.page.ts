import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  STATUS_COPY,
  availableCredit,
  formatMoney,
  parseMoneyToCents,
  type Loan,
  type QueueRow,
} from '@lj/contracts';
import { Api } from '../core/api';
import { SessionStore } from '../core/session';
import { Notice } from '../shared/notice';
import { StatusBadge } from '../shared/status-badge';
import { describe } from '../shared/workflow';

/** The purposes servicing recognises. Free text here is unqueryable later. */
const PURPOSES = ['Equipment', 'Operating', 'Land'] as const;
type Purpose = (typeof PURPOSES)[number];

/**
 * The borrower's file.
 *
 * This is a servicing screen, not a dashboard: three figures, a request form and
 * a list of what has been asked for. The one number that governs a decision —
 * available credit — is derived from the loan aggregate on every read, never
 * from a stored field, so it cannot drift away from the balance it came from.
 */
@Component({
  selector: 'app-my-file',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, Notice, StatusBadge],
  template: `
    <div class="mx-auto max-w-[64rem] px-6 py-8">
      <header class="mb-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line pb-4">
        <h1 class="text-2xl">My file</h1>
        <p class="text-sm text-muted">{{ session.displayName() }}</p>
      </header>

      <!-- Outside the async region: this reports a completed command, not loaded data. -->
      @if (confirmation(); as message) {
        <div class="mb-4">
          <app-notice tone="info" [dismissable]="true" (dismiss)="dismissConfirmation()">{{ message }}</app-notice>
        </div>
      }

      <div aria-live="polite" [attr.aria-busy]="loading()">
        @if (loading()) {
          <!-- Skeletons, never a placeholder figure or an invented status. -->
          <section class="panel" aria-hidden="true">
            <div class="panel-header"><span class="label-micro">Credit facility</span></div>
            <div class="grid divide-y divide-line-light sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              @for (slot of skeletonSlots; track slot) {
                <div class="px-4 py-3.5">
                  <div class="h-2 w-20 bg-sunken"></div>
                  <div class="mt-3 h-4 w-28 bg-subtle"></div>
                </div>
              }
            </div>
            <div class="border-t border-line-light px-4 py-3.5"><div class="h-1 w-full bg-sunken"></div></div>
          </section>

          <section class="panel mt-4" aria-hidden="true">
            <div class="panel-header"><span class="label-micro">Credit release requests</span></div>
            <ul class="divide-y divide-line-light">
              @for (slot of skeletonSlots; track slot) {
                <li class="px-4 py-3">
                  <div class="flex items-center gap-3">
                    <div class="h-3.5 w-24 bg-subtle"></div>
                    <div class="h-4 w-24 bg-sunken"></div>
                  </div>
                  <div class="mt-2.5 h-2 w-2/3 bg-sunken"></div>
                </li>
              }
            </ul>
          </section>
          <p class="sr-only">Loading your file…</p>
        } @else if (error(); as message) {
          <section class="panel p-4">
            <app-notice tone="bad">{{ message }}</app-notice>
            <button
              type="button"
              (click)="reload()"
              class="mt-3 border border-line-strong bg-surface px-3 py-1.5 text-sm font-medium text-body transition-colors hover:bg-sunken hover:text-ink"
            >Try again</button>
          </section>
        } @else if (facility(); as f) {
          <section class="panel" aria-labelledby="facility-heading">
            <div class="panel-header flex items-baseline justify-between gap-4">
              <h2 id="facility-heading" class="label-micro">Credit facility</h2>
              <span class="label-micro">{{ f.currency }}</span>
            </div>

            <div class="grid divide-y divide-line-light sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              @for (figure of f.figures; track figure.label) {
                <div class="px-4 py-3.5">
                  <div class="label-micro">{{ figure.label }}</div>
                  <div class="numeric mt-1.5 text-lg" [class]="figure.valueClass">{{ figure.value }}</div>
                  @if (figure.note) {
                    <div class="mt-1 text-sm text-faint">{{ figure.note }}</div>
                  }
                </div>
              }
            </div>

            <div class="border-t border-line-light px-4 py-3.5">
              <div
                class="h-1 w-full bg-sunken"
                role="progressbar"
                aria-label="Balance drawn against credit limit"
                aria-valuemin="0"
                aria-valuemax="100"
                [attr.aria-valuenow]="f.drawnPct"
                [attr.aria-valuetext]="f.drawnText"
              >
                <div class="h-1 bg-navy" [style.width.%]="f.drawnPct"></div>
              </div>
              <div class="mt-2 flex flex-wrap items-baseline justify-between gap-x-4">
                <span class="label-micro">{{ f.drawnPct }}% drawn</span>
                <span class="label-micro">{{ f.drawnText }}</span>
              </div>
            </div>
          </section>

          <section class="panel mt-4" aria-labelledby="release-heading">
            <div class="panel-header flex flex-wrap items-center justify-between gap-3">
              <h2 id="release-heading" class="label-micro">Request credit release</h2>
              <button
                #toggle
                type="button"
                (click)="toggleForm()"
                [attr.aria-expanded]="formOpen()"
                aria-controls="release-form"
                class="px-3 py-1.5 text-sm font-medium transition-colors"
                [class]="
                  formOpen()
                    ? 'border border-line-strong bg-surface text-body hover:bg-sunken hover:text-ink'
                    : 'bg-navy text-white hover:bg-navy-hover'
                "
              >{{ formOpen() ? 'Cancel' : 'Request credit release' }}</button>
            </div>

            @if (formOpen()) {
              <form id="release-form" (ngSubmit)="submit()" class="border-t border-line-light p-4">
                @if (formError(); as message) {
                  <div class="mb-4"><app-notice tone="bad">{{ message }}</app-notice></div>
                }

                <div class="flex flex-wrap items-end gap-4">
                  <div class="min-w-[11rem] flex-1">
                    <label class="label-micro mb-1.5 block" for="amount">Amount</label>
                    <input
                      id="amount"
                      name="amount"
                      type="text"
                      inputmode="decimal"
                      autocomplete="off"
                      placeholder="25,000"
                      aria-describedby="amount-help"
                      [attr.aria-invalid]="amountProblem() !== null"
                      [(ngModel)]="amountText"
                      [disabled]="submitting()"
                      class="numeric w-full border bg-surface px-2.5 py-2 text-base text-ink outline-none focus:border-navy disabled:bg-sunken"
                      [class]="amountProblem() ? 'border-bad-border' : 'border-line-strong'"
                    />
                  </div>

                  <div class="min-w-[11rem] flex-1">
                    <label class="label-micro mb-1.5 block" for="purpose">Purpose</label>
                    <select
                      id="purpose"
                      name="purpose"
                      [(ngModel)]="purpose"
                      [disabled]="submitting()"
                      class="w-full border border-line-strong bg-surface px-2.5 py-2 text-base text-ink outline-none focus:border-navy disabled:bg-sunken"
                    >
                      @for (option of purposes; track option) {
                        <option [value]="option">{{ option }}</option>
                      }
                    </select>
                  </div>

                  <button
                    type="submit"
                    [disabled]="!canSubmit()"
                    class="bg-navy px-4 py-2 text-base font-medium text-white transition-colors hover:bg-navy-hover disabled:opacity-50"
                  >{{ submitting() ? 'Submitting…' : 'Submit request' }}</button>
                </div>

                <p
                  id="amount-help"
                  class="mt-2 text-sm"
                  [class]="amountProblem() ? 'text-bad-deep' : 'text-muted'"
                >{{ amountProblem() ?? availableHint() }}</p>
              </form>
            }
          </section>

          <section class="panel mt-4" aria-labelledby="applications-heading">
            <div class="panel-header flex items-baseline justify-between gap-4">
              <h2 id="applications-heading" class="label-micro">Applications</h2>
              <a
                routerLink="/apply/new"
                class="border border-line-strong bg-surface px-2.5 py-1 text-sm font-medium text-body transition-colors hover:border-navy-border hover:bg-navy-bg hover:text-navy hover:no-underline"
              >Start an application</a>
            </div>

            @if (applications().length === 0) {
              <div class="px-6 py-8 text-center">
                <p class="text-base text-body">
                  No applications on file. An application opens a new facility; it saves as you go, so
                  you can leave it and come back.
                </p>
              </div>
            } @else {
              <ul class="divide-y divide-line-light">
                @for (row of applications(); track row.id) {
                  <li>
                    <a
                      [routerLink]="row.link"
                      class="block px-4 py-3 transition-colors hover:bg-row hover:no-underline focus-visible:bg-row"
                    >
                      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                        <span class="numeric text-md font-medium text-ink">{{ row.amount ?? 'Not yet costed' }}</span>
                        <app-status-badge [status]="row.status" />
                        <span class="numeric ml-auto text-xs text-faint">{{ row.when }}</span>
                      </div>
                      <p class="mt-1 max-w-[74ch] text-sm text-muted">{{ row.explanation }}</p>
                    </a>
                  </li>
                }
              </ul>
            }
          </section>

          <section class="panel mt-4" aria-labelledby="requests-heading">
            <div class="panel-header flex items-baseline justify-between gap-4">
              <h2 id="requests-heading" class="label-micro">Credit release requests</h2>
              <span class="label-micro">{{ rows().length }}</span>
            </div>

            @if (rows().length === 0) {
              <div class="px-6 py-10 text-center">
                <p class="text-md font-medium text-ink">No requests yet</p>
                <p class="mx-auto mt-1.5 max-w-[44ch] text-base text-body">
                  Anything you draw against this facility appears here, with where it has got to.
                </p>
              </div>
            } @else {
              <ul class="divide-y divide-line-light">
                @for (row of rows(); track row.id) {
                  <li>
                    <a
                      [routerLink]="['/requests', row.id]"
                      class="block px-4 py-3 transition-colors hover:bg-row hover:no-underline focus-visible:bg-row"
                    >
                      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                        <span class="numeric text-md font-medium text-ink">{{ row.amount }}</span>
                        <app-status-badge [status]="row.status" />
                        <span class="numeric ml-auto text-xs text-faint">{{ row.when }}</span>
                      </div>
                      <p class="mt-1 max-w-[74ch] text-sm text-muted">{{ row.explanation }}</p>
                    </a>
                  </li>
                }
              </ul>
            }
          </section>
        } @else {
          <section class="panel px-6 py-12 text-center">
            <p class="text-md font-medium text-ink">No facility on file</p>
            <p class="mx-auto mt-1.5 max-w-[48ch] text-base text-body">
              There is no credit facility against your name yet. Once one is opened, your limit, balance
              and available credit appear here and you can request releases against it.
            </p>
          
            <a
              routerLink="/apply/new"
              class="mt-5 inline-block bg-navy px-3 py-2 text-base font-medium text-white transition-colors hover:bg-navy-hover hover:no-underline"
            >Apply for a facility</a>
          </section>
        }
      </div>
    </div>
  `,
})
export class MyFilePage {
  private readonly api = inject(Api);
  protected readonly session = inject(SessionStore);

  /** Kept so focus has somewhere to land when the form collapses under it. */
  private readonly toggle = viewChild<ElementRef<HTMLButtonElement>>('toggle');

  protected readonly purposes = PURPOSES;
  protected readonly skeletonSlots = [0, 1, 2];

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  private readonly loan = signal<Loan | null>(null);
  private readonly requests = signal<readonly QueueRow[]>([]);

  protected readonly formOpen = signal(false);
  protected readonly submitting = signal(false);
  protected readonly formError = signal<string | null>(null);
  protected readonly confirmation = signal<string | null>(null);
  protected readonly amountText = signal('');
  protected readonly purpose = signal<Purpose>('Equipment');

  constructor() {
    // Zoneless: the fetch resolves and writes signals, and those writes are what
    // schedule the render. Nothing here needs a zone to notice.
    void this.load();
  }

  // -- Derived presentation --------------------------------------------------

  /** Always computed from the aggregate. There is no stored "available" field. */
  private readonly available = computed(() => {
    const loan = this.loan();
    return loan ? availableCredit(loan) : 0;
  });

  protected readonly availableHint = computed(
    () => `Up to ${formatMoney(this.available())} is available on this facility.`,
  );

  protected readonly facility = computed(() => {
    const loan = this.loan();
    if (!loan) return null;

    return {
      currency: loan.currency,
      figures: [
        {
          label: 'Credit limit',
          value: formatMoney(loan.creditLimit),
          valueClass: 'text-body',
          note: null as string | null,
        },
        {
          label: 'Current balance',
          value: formatMoney(loan.balance),
          valueClass: 'text-body',
          note: null as string | null,
        },
        {
          // The figure a borrower actually acts on, so it carries the weight.
          label: 'Available credit',
          value: formatMoney(availableCredit(loan)),
          valueClass: 'font-medium text-ink',
          note: 'Limit less balance',
        },
      ],
      // A bar width, not money. Cents stay integers; only this ratio is a float.
      drawnPct:
        loan.creditLimit > 0
          ? Math.min(100, Math.round((loan.balance / loan.creditLimit) * 100))
          : 0,
      drawnText: `${formatMoney(loan.balance)} of ${formatMoney(loan.creditLimit)} drawn`,
    };
  });

  private readonly amountCents = computed(() => parseMoneyToCents(this.amountText().trim()));

  /**
   * A mirror of the server's `amount_within_available_credit` guard, so the
   * borrower hears the reason without a round trip. It is a courtesy, not a
   * control: the API re-runs the same rule against the current balance at
   * creation, and again at funding, and that answer is the authoritative one.
   */
  protected readonly amountProblem = computed<string | null>(() => {
    const typed = this.amountText().trim();
    if (typed === '') return null; // an untouched field is not yet a mistake
    const cents = this.amountCents();
    if (cents === null) return 'Enter an amount in dollars, for example 25,000.';
    if (cents <= 0) return 'Amount must be greater than zero.';
    if (cents > this.available()) {
      return `That is more than the ${formatMoney(this.available())} available on this facility.`;
    }
    return null;
  });

  protected readonly canSubmit = computed(
    () => this.amountText().trim() !== '' && this.amountProblem() === null && !this.submitting(),
  );

  /**
   * Credit releases only. Applications ride the same workflow but belong to the
   * application flow, and mixing them here would make the list mean two things.
   */
  /**
   * Applications, kept as their own list for the reason above: a borrower asking
   * "where is my application" and "what have I drawn" are two different
   * questions, and one list answering both answers neither well.
   */
  protected readonly applications = computed(() =>
    this.requests()
      .filter((request) => request.type === 'application')
      .map((request) => ({
        id: request.id,
        amount: request.amount > 0 ? formatMoney(request.amount) : null,
        status: request.status,
        when: formatDate(request.createdAt),
        explanation: STATUS_COPY[request.status].borrower,
        // A draft resumes into the form; anything submitted is read-only.
        link: request.status === 'draft' ? ['/apply', request.id] : ['/requests', request.id],
      })),
  );

  protected readonly rows = computed(() =>
    this.requests()
      .filter((request) => request.type === 'credit_release')
      .map((request) => ({
        id: request.id,
        amount: formatMoney(request.amount),
        status: request.status,
        when: formatDate(request.createdAt),
        explanation: STATUS_COPY[request.status].borrower,
      })),
  );

  // -- Commands --------------------------------------------------------------

  protected reload(): void {
    void this.load();
  }

  protected dismissConfirmation(): void {
    this.confirmation.set(null);
  }

  protected toggleForm(): void {
    const opening = !this.formOpen();
    this.formOpen.set(opening);
    this.formError.set(null);
    if (opening) {
      this.confirmation.set(null);
    } else {
      this.resetForm();
    }
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) return; // the button is disabled too; never rely on that alone

    const cents = this.amountCents();
    if (cents === null || this.amountProblem() !== null) return;

    this.submitting.set(true);
    this.formError.set(null);

    try {
      const created = await this.api.createCreditRelease(cents, this.purpose());
      // Re-read rather than splicing the response into the list: status and
      // balance are the server's to state, and this screen shows only what it
      // committed.
      await this.refresh();
      // The status named here is the one that came back, not one we assumed.
      this.confirmation.set(
        `Your request for ${formatMoney(cents)} was created. It is listed below as ` +
          `“${STATUS_COPY[created.request.status].label}”.`,
      );
      this.formOpen.set(false);
      this.resetForm();
      // The submit button is about to leave the DOM; take focus with it.
      this.toggle()?.nativeElement.focus();
    } catch (failure) {
      this.formError.set(describe(failure));
    } finally {
      this.submitting.set(false);
    }
  }

  // -- Data ------------------------------------------------------------------

  /** First load and explicit retry — this is the one that shows skeletons. */
  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.apply(await this.api.myLoan());
    } catch (failure) {
      this.error.set(describe(failure));
    } finally {
      this.loading.set(false);
    }
  }

  /** Refresh in place after a command, so the screen does not flash empty. */
  private async refresh(): Promise<void> {
    try {
      this.apply(await this.api.myLoan());
    } catch (failure) {
      this.error.set(describe(failure));
    }
  }

  private apply(data: { loan: Loan | null; requests: QueueRow[] }): void {
    this.loan.set(data.loan);
    this.requests.set(data.requests);
  }

  private resetForm(): void {
    this.amountText.set('');
    this.purpose.set('Equipment');
    this.formError.set(null);
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
