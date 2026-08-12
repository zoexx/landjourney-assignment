/**
 * The lender's review queue.
 *
 * This is the densest surface in the product and the one a loan officer lives
 * in, so it is a real table: fixed columns, tabular numerals, hairline rules and
 * nothing that moves. Every row is a keyboard tab stop because triage is done
 * with the hands on the keyboard, not the mouse.
 *
 * The status filter is applied client-side. The queue is a working set an
 * officer flips through, so re-fetching on every filter click would add latency
 * to the one interaction that has to feel instantaneous — and it would make the
 * per-filter counts impossible to show.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  STATUS_COPY,
  formatMoneyCompact,
  type EligibilityLevel,
  type QueueRow,
  type RequestStatus,
  type RequestType,
} from '@lj/contracts';
import { Api } from '../core/api';
import { EligibilityBadge } from '../shared/eligibility-badge';
import { StatusBadge } from '../shared/status-badge';
import { describe } from '../shared/workflow';

type Filter = RequestStatus | 'all';

/**
 * Drafts never reach a lender (the API excludes them), so they are not offered
 * as a filter. The order is the order work actually flows in.
 */
const FILTERS: readonly Filter[] = [
  'all',
  'submitted',
  'under_review',
  'approved',
  'declined',
  'funded',
];

const TYPE_LABEL: Record<RequestType, string> = {
  application: 'Application',
  credit_release: 'Credit release',
};

interface RowView {
  id: string;
  borrower: string;
  type: string;
  amount: string;
  submitted: string;
  status: RequestStatus;
  eligibility: EligibilityLevel | null;
  available: string;
  /** Spoken when the row receives focus — the cells alone read as a word salad. */
  aria: string;
}

@Component({
  selector: 'app-queue',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatusBadge, EligibilityBadge],
  template: `
    <div class="mx-auto max-w-[1400px] px-6 py-6">
      <div class="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <div>
          <h1 class="text-xl">Review queue</h1>
          <p class="mt-0.5 text-base text-body">
            Every request across the book, most recent first.
          </p>
        </div>
        @if (rows(); as all) {
          <p class="label-micro">
            <span class="numeric">{{ visible().length }}</span> of
            <span class="numeric">{{ all.length }}</span> shown
          </p>
        }
      </div>

      @if (!error()) {
        <!--
          Segmented control. Borders are collapsed with a negative margin so the
          group reads as one control rather than six buttons. It is withheld
          while the queue is unreadable, since every count would be a lie.
        -->
        <div role="group" aria-label="Filter by status" class="mb-3 flex flex-wrap">
          @for (option of filters(); track option.value) {
            <button
              type="button"
              (click)="filter.set(option.value)"
              [attr.aria-pressed]="filter() === option.value"
              class="-ml-px inline-flex items-center gap-1.5 border px-2.5 py-1 font-mono text-xs font-medium transition-colors first:ml-0"
              [class]="option.value === filter() ? SELECTED : UNSELECTED"
            >
              <span>{{ option.label }}</span>
              <span class="numeric text-2xs opacity-70">{{ option.count }}</span>
            </button>
          }
        </div>
      }

      @if (error(); as message) {
        <!-- ERROR. Distinct from empty: nothing is claimed about what is in the queue. -->
        <div class="panel px-6 py-10 text-center">
          <p aria-hidden="true" class="font-mono text-md text-bad">✕</p>
          <h2 class="mt-2 text-md">The queue could not be loaded</h2>
          <p class="mx-auto mt-1 max-w-[34rem] text-base text-body">{{ message }}</p>
          <button
            type="button"
            (click)="reload()"
            class="mt-4 border border-line-strong bg-surface px-3 py-1.5 text-base font-medium text-body transition-colors hover:bg-sunken hover:text-ink"
          >
            Try again
          </button>
        </div>
      } @else {
        <div class="panel">
          <div class="overflow-x-auto">
            <table class="w-full border-collapse">
              <caption class="sr-only">
                Credit requests awaiting servicing, filtered by {{ activeLabel() }}
              </caption>
              <thead>
                <tr class="border-b border-line bg-sunken">
                  <th scope="col" class="label-micro px-3 py-2 text-left">Borrower</th>
                  <th scope="col" class="label-micro px-3 py-2 text-left">Type</th>
                  <th scope="col" class="label-micro px-3 py-2 text-right">Amount</th>
                  <th scope="col" class="label-micro px-3 py-2 text-left">Submitted</th>
                  <th scope="col" class="label-micro px-3 py-2 text-left">Status</th>
                  <th scope="col" class="label-micro px-3 py-2 text-left">Eligibility</th>
                  <th scope="col" class="label-micro px-3 py-2 text-right">Available credit</th>
                </tr>
              </thead>

              <tbody>
                @if (loading()) {
                  <!--
                    LOADING. Neutral bars only — a placeholder badge would flash a
                    status this request may not actually be in.
                  -->
                  @for (row of SKELETON; track $index; let odd = $odd) {
                    <tr aria-hidden="true" class="border-b border-line-light" [class.bg-row]="odd">
                      @for (cell of row; track $index) {
                        <td class="px-3 py-2.5">
                          <span class="block h-2.5 animate-pulse bg-sunken" [style.width]="cell"></span>
                        </td>
                      }
                    </tr>
                  }
                } @else if (visible().length === 0) {
                  <tr>
                    <td colspan="7" class="px-6 py-12 text-center">
                      @if (rows()?.length) {
                        <!-- EMPTY under this filter — the queue itself is not empty. -->
                        <h2 class="text-md">No requests are {{ activeLabel() }}</h2>
                        <p class="mt-1 text-base text-body">
                          Other requests are waiting under a different status.
                        </p>
                        <button
                          type="button"
                          (click)="filter.set('all')"
                          class="mt-3 border border-line-strong bg-surface px-3 py-1.5 text-base font-medium text-body transition-colors hover:bg-sunken hover:text-ink"
                        >
                          Show all
                        </button>
                      } @else {
                        <!-- EMPTY, genuinely. -->
                        <h2 class="text-md">Nothing in the queue</h2>
                        <p class="mt-1 text-base text-body">
                          No borrower has submitted a request yet. New submissions land here.
                        </p>
                      }
                    </td>
                  </tr>
                } @else {
                  @for (row of visible(); track row.id; let odd = $odd) {
                    <!--
                      The row is the tab stop rather than a link inside a cell, so
                      the whole row is one target for both pointer and keyboard.
                      Negative outline offset keeps the focus ring inside the
                      table's horizontal scroll container.
                    -->
                    <tr
                      tabindex="0"
                      [attr.aria-label]="row.aria"
                      (click)="open(row.id)"
                      (keydown.enter)="open(row.id, $event)"
                      (keydown.space)="open(row.id, $event)"
                      class="cursor-pointer border-b border-line-light transition-colors hover:bg-navy-bg focus-visible:[outline-offset:-2px]"
                      [class.bg-row]="odd"
                    >
                      <th scope="row" class="px-3 py-2 text-left text-base font-medium text-ink">
                        {{ row.borrower }}
                      </th>
                      <td class="px-3 py-2 text-sm text-muted">{{ row.type }}</td>
                      <td class="numeric px-3 py-2 text-right text-base font-medium text-ink">
                        {{ row.amount }}
                      </td>
                      <td class="numeric px-3 py-2 text-sm text-muted">{{ row.submitted }}</td>
                      <td class="px-3 py-2"><app-status-badge [status]="row.status" /></td>
                      <td class="px-3 py-2">
                        @if (row.eligibility; as level) {
                          <app-eligibility-badge [level]="level" />
                        } @else {
                          <span aria-hidden="true" class="text-sm text-faint">—</span>
                          <span class="sr-only">Not evaluated</span>
                        }
                      </td>
                      <td class="numeric px-3 py-2 text-right text-sm text-body">
                        {{ row.available }}
                      </td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>
        </div>

        @if (visible().length > 0) {
          <p class="mt-2 text-sm text-faint">
            Select a row, or press Enter on it, to open the request.
          </p>
        }
      }

      <!-- Announced without stealing focus, so the state change is not silent. -->
      <p aria-live="polite" class="sr-only">{{ announcement() }}</p>
    </div>
  `,
})
export class QueuePage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);

  /** Null until the first fetch resolves — distinguishes "loading" from "empty". */
  private readonly rowData = signal<QueueRow[] | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly filter = signal<Filter>('all');

  protected readonly rows = this.rowData.asReadonly();

  protected readonly SELECTED = 'border-navy bg-navy text-white';
  protected readonly UNSELECTED =
    'border-line-strong bg-surface text-body hover:bg-sunken hover:text-ink';

  /** Cell widths for the skeleton, so the placeholder has the table's rhythm. */
  protected readonly SKELETON: readonly (readonly string[])[] = Array.from({ length: 6 }, () => [
    '8rem',
    '5.5rem',
    '4.5rem',
    '5rem',
    '6rem',
    '5.5rem',
    '5rem',
  ]);

  constructor() {
    void this.reload();
  }

  protected readonly counts = computed(() => {
    const all = this.rowData() ?? [];
    const counts = new Map<Filter, number>([['all', all.length]]);
    for (const row of all) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
    return counts;
  });

  protected readonly filters = computed(() =>
    FILTERS.map((value) => ({
      value,
      label: value === 'all' ? 'All' : STATUS_COPY[value].label,
      count: this.counts().get(value) ?? 0,
    })),
  );

  protected readonly activeLabel = computed(() => {
    const value = this.filter();
    return value === 'all' ? 'all statuses' : STATUS_COPY[value].label.toLowerCase();
  });

  protected readonly visible = computed<RowView[]>(() => {
    const active = this.filter();
    const all = this.rowData() ?? [];
    return all.filter((row) => active === 'all' || row.status === active).map(toView);
  });

  protected readonly announcement = computed(() => {
    if (this.loading()) return 'Loading the review queue.';
    if (this.error()) return 'The queue could not be loaded.';
    return `${this.visible().length} requests shown, filtered by ${this.activeLabel()}.`;
  });

  protected async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.rowData.set(await this.api.requests());
    } catch (failure) {
      // Hold no rows rather than show a stale set beside a fresh error.
      this.rowData.set(null);
      this.error.set(describe(failure));
    } finally {
      this.loading.set(false);
    }
  }

  protected open(id: string, event?: Event): void {
    // Space scrolls the page by default; Enter on a non-button does nothing.
    event?.preventDefault();
    void this.router.navigate(['/requests', id]);
  }
}

function toView(row: QueueRow): RowView {
  const borrower = row.borrowerName ?? 'Unnamed borrower';
  const amount = formatMoneyCompact(row.amount);
  const type = TYPE_LABEL[row.type];
  return {
    id: row.id,
    borrower,
    type,
    amount,
    submitted: formatDate(row.createdAt),
    status: row.status,
    eligibility: row.eligibilityLevel,
    // An application has no facility yet, so there is no headroom to report.
    available: row.loanAvailableCredit === null ? '—' : formatMoneyCompact(row.loanAvailableCredit),
    aria: `${borrower}, ${type}, ${amount}, ${STATUS_COPY[row.status].label}`,
  };
}

/** ISO-style short date: it sorts, it aligns, and it is unambiguous. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA');
}
