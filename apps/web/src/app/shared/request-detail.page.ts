/**
 * The request detail screen — one screen, two audiences.
 *
 * A borrower and a lender look at the same underlying record, so they share a
 * component. What differs is not the data model but the *stance*: the borrower
 * is told where their money is, the lender is given the controls. Forking this
 * into two pages would mean maintaining two renderings of one truth.
 *
 * The action panel derives entirely from the transition map. There is not a
 * single `status === 'under_review'` check driving a button anywhere in this
 * file: if the map says a move is illegal, no button for it can be produced,
 * and if a guard currently fails the button is rendered disabled with the
 * guard's own reason underneath. A lender should never wonder why an action is
 * missing — it is not missing, it is explained.
 */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  ELIGIBILITY_COPY,
  FAILURE_COPY,
  STATUS_COPY,
  availableCredit,
  formatMoney,
  isTerminal,
  statusCopyFor,
  type EligibilityLevel,
  type RequestStatus,
  type RequestType,
  type Role,
  type TransitionDef,
} from '@lj/contracts';
import { SessionStore } from '../core/session';
import { EligibilityBadge } from './eligibility-badge';
import { Notice } from './notice';
import { StatusBadge } from './status-badge';
import { Timeline } from './timeline';
import { WorkflowStore } from './workflow';

const TYPE_LABEL: Record<RequestType, string> = {
  application: 'Application',
  credit_release: 'Credit release',
};

const INTENT_CLASS: Record<TransitionDef['intent'], string> = {
  primary: 'border-navy bg-navy text-white hover:bg-navy-hover',
  danger: 'border-bad-border bg-bad-bg text-bad-deep hover:border-bad',
  default: 'border-line-strong bg-surface text-body hover:bg-sunken hover:text-ink',
};

/** Present tense, because the command is happening right now and might not land. */
const IN_FLIGHT: Partial<Record<RequestStatus, string>> = {
  under_review: 'Starting review…',
  approved: 'Approving…',
  declined: 'Declining…',
  funded: 'Releasing funds…',
};

/** Per-rule glyph + word. Colour is never the only signal. */
const RULE_LEVEL: Record<EligibilityLevel, { glyph: string; cls: string; spoken: string }> = {
  green: { glyph: '✓', cls: 'text-ok', spoken: 'Within policy' },
  amber: { glyph: '!', cls: 'text-warn', spoken: 'Outside preference' },
  red: { glyph: '✕', cls: 'text-bad', spoken: 'Outside policy' },
};

interface ActionView {
  to: RequestStatus;
  label: string;
  cls: string;
  enabled: boolean;
  blockedReason: string | null;
  requiresNote: boolean;
  /** This action's note form is showing, so the button now confirms it. */
  noteOpen: boolean;
  disabled: boolean;
}

@Component({
  selector: 'app-request-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, StatusBadge, EligibilityBadge, Notice, Timeline],
  template: `
    <div class="mx-auto max-w-[1400px] px-6 py-6">
      <a [routerLink]="backLink()" class="label-micro !text-navy hover:underline">
        <span aria-hidden="true">←</span> {{ backLabel() }}
      </a>

      @if (current(); as req) {
        <!-- Header. Amount first: it is the number every conversation starts with. -->
        <div class="panel mt-3 p-5">
          <div class="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
            <div>
              <div class="label-micro mb-1.5">{{ TYPE_LABEL[req.type] }}</div>
              <div class="flex flex-wrap items-center gap-3">
                <span class="numeric text-3xl font-medium text-ink">{{ amount() }}</span>
                <app-status-badge [status]="req.status" />
              </div>
              <p class="mt-1.5 text-base text-body">
                {{ req.borrowerName ?? 'Unnamed borrower' }}
                <span aria-hidden="true" class="text-faint"> · </span>
                <span class="numeric text-sm text-muted">
                  <span class="sr-only">Submitted </span>{{ submitted() }}
                </span>
              </p>
            </div>
            <div class="text-right">
              <div class="label-micro">Reference</div>
              <div class="numeric mt-0.5 text-sm text-muted">{{ reference() }}</div>
            </div>
          </div>

          <!-- The same status, said differently depending on who is reading. -->
          <p class="mt-4 border-t border-line-light pt-3 text-base text-body">
            {{ explanation() }}
          </p>
        </div>

        <div class="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
          <div class="space-y-4">
            @if (req.status === 'declined') {
              <!-- Highest in the column: a decline is the answer, not a footnote. -->
              <div class="border border-bad-border bg-bad-bg p-4">
                <div class="label-micro !text-bad-deep flex items-center gap-1.5">
                  <span aria-hidden="true">✕</span> Reason for decline
                </div>
                <p class="mt-1.5 text-base text-bad-deep">
                  {{ req.declineNote ?? 'No reason was recorded against this decision.' }}
                </p>
              </div>
            }

            <div class="panel">
              <div class="panel-header"><h2 class="label-micro">Request details</h2></div>
              <dl class="divide-y divide-line-light">
                @for (row of details(); track row.label) {
                  <div class="flex items-baseline justify-between gap-6 px-4 py-2">
                    <dt class="text-sm text-muted">{{ row.label }}</dt>
                    <dd class="text-right text-base text-ink" [class.numeric]="row.mono">
                      {{ row.value }}
                    </dd>
                  </div>
                }
              </dl>
            </div>

            @if (isLender()) {
              <!-- Loan internals are lender-only: a borrower is shown their own file elsewhere. -->
              <div class="panel">
                <div class="panel-header"><h2 class="label-micro">Loan context</h2></div>
                @if (loanView(); as loan) {
                  <dl class="grid grid-cols-3 divide-x divide-line-light">
                    <div class="px-4 py-3">
                      <dt class="label-micro">Credit limit</dt>
                      <dd class="numeric mt-1 text-md text-ink">{{ loan.limit }}</dd>
                    </div>
                    <div class="px-4 py-3">
                      <dt class="label-micro">Balance</dt>
                      <dd class="numeric mt-1 text-md text-ink">{{ loan.balance }}</dd>
                    </div>
                    <div class="px-4 py-3">
                      <dt class="label-micro">Available credit</dt>
                      <dd class="numeric mt-1 text-md font-medium text-ink">{{ loan.available }}</dd>
                    </div>
                  </dl>
                  @if (loan.short) {
                    <p class="flex items-start gap-2 border-t border-warn-border bg-warn-bg px-4 py-2 text-sm text-warn-deep">
                      <span aria-hidden="true" class="font-mono">!</span>
                      This request is larger than the credit currently available. Funding
                      re-checks the balance and will refuse if it is still short.
                    </p>
                  }
                  <p class="border-t border-line-light px-4 py-2 text-sm text-faint">
                    Available credit is derived from limit less balance — it is never stored.
                  </p>
                } @else {
                  <p class="px-4 py-3 text-base text-muted">
                    No facility on this borrower yet. One is created when this application is
                    funded.
                  </p>
                }
              </div>
            }

            @if (eligibility(); as elig) {
              <div class="panel">
                <div class="panel-header flex items-center justify-between gap-3">
                  <h2 class="label-micro">Eligibility</h2>
                  <app-eligibility-badge [level]="elig.level" />
                </div>
                <p class="px-4 py-2.5 text-base text-body">{{ elig.summary }}</p>
                <ul class="divide-y divide-line-light border-t border-line-light">
                  @for (rule of elig.outcomes; track rule.key) {
                    <li class="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 px-4 py-2">
                      <span aria-hidden="true" class="font-mono text-xs" [class]="rule.cls">
                        {{ rule.glyph }}
                      </span>
                      <span class="sr-only">{{ rule.spoken }}:</span>
                      <span class="flex-1 text-base text-ink">{{ rule.label }}</span>
                      <span class="numeric text-sm text-muted">{{ rule.detail }}</span>
                    </li>
                  }
                </ul>
                <p class="label-micro border-t border-line-light px-4 py-2">
                  Evaluated {{ elig.evaluatedAt }}
                </p>
              </div>
            }

            <div class="panel">
              <div class="panel-header"><h2 class="label-micro">History</h2></div>
              <div class="p-4">
                <!-- Append-only event log, never reconstructed from the current status. -->
                <app-timeline [events]="workflow.events()" />
              </div>
            </div>
          </div>

          <aside class="lg:sticky lg:top-4">
            <div class="panel">
              <div class="panel-header">
                <h2 class="label-micro">{{ isLender() ? 'Actions' : 'What happens next' }}</h2>
              </div>
              <div class="p-4">
                <!--
                  Stale conflicts and guard refusals surface here. The region is
                  always in the DOM so a notice appearing in it is announced.
                -->
                <div aria-live="polite">
                  @if (workflow.notice(); as notice) {
                    <app-notice
                      class="mb-3 block"
                      [tone]="notice.tone"
                      [dismissable]="true"
                      (dismiss)="workflow.clearNotice()"
                      >{{ notice.message }}</app-notice
                    >
                  }
                </div>

                @if (isLender()) {
                  @if (actions().length === 0) {
                    <p class="text-base text-body">{{ noActionCopy() }}</p>
                  } @else {
                    <div class="space-y-3">
                      @for (action of actions(); track action.to) {
                        <div>
                          @if (action.noteOpen) {
                            <!--
                              A decline must carry a reason: the note is written
                              into the event log and shown to the borrower, so it
                              is collected before the command is dispatched, not
                              after.
                            -->
                            <div class="mb-2.5">
                              <label class="label-micro mb-1.5 block" for="decline-reason">
                                Reason for decline
                              </label>
                              <textarea
                                #noteInput
                                id="decline-reason"
                                rows="4"
                                [value]="noteText()"
                                (input)="onNoteInput($event)"
                                [disabled]="workflow.busy()"
                                [attr.aria-invalid]="noteError() !== null"
                                [attr.aria-describedby]="noteError() ? 'decline-error' : null"
                                placeholder="What the borrower will be told."
                                class="w-full resize-y border border-line-strong bg-surface px-2.5 py-2 text-base text-ink outline-none focus:border-navy disabled:bg-sunken"
                              ></textarea>

                              @if (noteError(); as message) {
                                <p
                                  id="decline-error"
                                  role="alert"
                                  class="mt-1.5 flex items-start gap-1.5 text-sm text-bad-deep"
                                >
                                  <span aria-hidden="true" class="font-mono">✕</span>{{ message }}
                                </p>
                              }
                            </div>
                          }

                          <!--
                            The button is deliberately outside the block above so
                            revealing the form never destroys the element the
                            lender's focus is sitting on.
                          -->
                          <div class="flex gap-2">
                            <button
                              #actionButton
                              type="button"
                              (click)="run(action)"
                              [disabled]="action.disabled"
                              class="flex-1 border px-3 py-2 text-base font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                              [class]="action.cls"
                            >
                              {{ action.label }}
                            </button>
                            @if (action.noteOpen) {
                              <button
                                type="button"
                                (click)="cancelNote(actionButton)"
                                [disabled]="workflow.busy()"
                                class="border border-line-strong bg-surface px-3 py-2 text-base text-body transition-colors hover:bg-sunken hover:text-ink disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            }
                          </div>

                          @if (!action.enabled && action.blockedReason) {
                            <!-- Shown, never hidden: the lender must know why. -->
                            <p class="mt-1.5 flex items-start gap-1.5 text-sm text-muted">
                              <span aria-hidden="true" class="font-mono text-warn">!</span>
                              {{ action.blockedReason }}
                            </p>
                          }
                        </div>
                      }
                    </div>
                  }
                } @else {
                  <p class="text-base text-body">{{ explanation() }}</p>
                  @if (req.status === 'draft') {
                    <a
                      [routerLink]="['/apply', req.id]"
                      class="mt-3 inline-block border border-navy bg-navy px-3 py-2 text-base font-medium !text-white hover:bg-navy-hover hover:no-underline"
                    >
                      Continue application
                    </a>
                  } @else {
                    <p class="mt-2 text-sm text-muted">
                      No action is required from you. This page updates as your request moves.
                    </p>
                  }
                }
              </div>
            </div>
          </aside>
        </div>
      } @else if (workflow.loading() || !attempted()) {
        <!-- LOADING. Structure only — no badge, no amount, nothing invented. -->
        <div aria-hidden="true" class="mt-3 space-y-4">
          <div class="panel space-y-3 p-5">
            <span class="block h-2.5 w-24 animate-pulse bg-sunken"></span>
            <span class="block h-7 w-48 animate-pulse bg-sunken"></span>
            <span class="block h-2.5 w-64 animate-pulse bg-sunken"></span>
          </div>
          <div class="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
            <div class="panel space-y-3 p-5">
              @for (line of [1, 2, 3, 4, 5]; track line) {
                <span class="block h-2.5 animate-pulse bg-sunken" [style.width]="line * 14 + '%'"></span>
              }
            </div>
            <div class="panel space-y-3 p-5">
              <span class="block h-2.5 w-20 animate-pulse bg-sunken"></span>
              <span class="block h-8 w-full animate-pulse bg-sunken"></span>
            </div>
          </div>
        </div>
      } @else if (failure(); as fail) {
        <div class="panel mt-3 px-6 py-12 text-center">
          <p aria-hidden="true" class="font-mono text-md" [class]="fail.glyphClass">
            {{ fail.glyph }}
          </p>
          <h1 class="mt-2 text-md">{{ fail.heading }}</h1>
          <p class="mx-auto mt-1 max-w-[34rem] text-base text-body">{{ fail.message }}</p>
          <div class="mt-4 flex justify-center gap-2">
            @if (fail.retryable) {
              <button
                type="button"
                (click)="reload()"
                class="border border-line-strong bg-surface px-3 py-1.5 text-base font-medium text-body transition-colors hover:bg-sunken hover:text-ink"
              >
                Try again
              </button>
            }
            <a
              [routerLink]="backLink()"
              class="border border-line-strong bg-surface px-3 py-1.5 text-base font-medium !text-body transition-colors hover:bg-sunken hover:!text-ink hover:no-underline"
            >
              {{ backLabel() }}
            </a>
          </div>
        </div>
      }

      <!--
        Always in the DOM: a live region inserted together with its text is not
        reliably announced, so the region outlives the states it describes.
      -->
      <p aria-live="polite" class="sr-only">{{ announcement() }}</p>
    </div>
  `,
})
export class RequestDetailPage {
  /** Bound from the route by `withComponentInputBinding()`. */
  readonly id = input.required<string>();

  private readonly session = inject(SessionStore);
  protected readonly workflow = inject(WorkflowStore);

  protected readonly TYPE_LABEL = TYPE_LABEL;
  protected readonly isLender = this.session.isLender;

  /** Which transition's note form is open, if any. */
  protected readonly noteFor = signal<RequestStatus | null>(null);
  protected readonly noteText = signal('');
  protected readonly noteError = signal<string | null>(null);

  /**
   * Whether a fetch has been asked for at all. Without it the very first frame —
   * before the load effect has run — reads as "not found", which is the one
   * thing a detail screen must never say about a request that exists.
   */
  protected readonly attempted = signal(false);

  private readonly noteInput = viewChild<ElementRef<HTMLTextAreaElement>>('noteInput');

  constructor() {
    // Fetching on route change is a genuine side effect, so it belongs in an
    // effect. Transient note state is dropped with the request it belonged to.
    effect(() => {
      const id = this.id();
      this.resetNote();
      this.attempted.set(true);
      void this.workflow.load(id);
    });

    // Revealing a required field and leaving the caret behind it is a dead end
    // for a keyboard user, so focus follows the form open.
    effect(() => {
      if (this.noteFor()) this.noteInput()?.nativeElement.focus();
    });
  }

  private readonly role = computed<Role>(() => (this.isLender() ? 'lender' : 'borrower'));

  /**
   * The store is a singleton, so it can still be holding the previously viewed
   * request while this one loads. Rendering is gated on the held record being
   * the one this route asked for — otherwise a lender would see another
   * borrower's amount for a frame.
   */
  protected readonly current = computed(() => {
    const request = this.workflow.request();
    return request && request.id === this.id() ? request : null;
  });

  protected readonly amount = computed(() => {
    const request = this.current();
    return request ? formatMoney(request.amount) : '';
  });

  protected readonly submitted = computed(() => {
    const request = this.current();
    return request ? formatDateTime(request.createdAt) : '';
  });

  protected readonly reference = computed(() => this.id().slice(0, 8).toUpperCase());

  protected readonly explanation = computed(() => {
    const request = this.current();
    return request ? statusCopyFor(request.status, this.role()) : '';
  });

  protected readonly backLink = computed(() => (this.isLender() ? '/queue' : '/my-file'));
  protected readonly backLabel = computed(() =>
    this.isLender() ? 'Review queue' : 'My file',
  );

  protected readonly details = computed(() => {
    const request = this.current();
    if (!request) return [];
    return [
      { label: 'Amount', value: formatMoney(request.amount), mono: true },
      { label: 'Type', value: TYPE_LABEL[request.type], mono: false },
      { label: 'Purpose', value: request.purpose ?? 'Not stated', mono: false },
      { label: 'Borrower', value: request.borrowerName ?? 'Unnamed borrower', mono: false },
      { label: 'Submitted', value: formatDateTime(request.createdAt), mono: true },
      { label: 'Last updated', value: formatDateTime(request.updatedAt), mono: true },
    ];
  });

  protected readonly loanView = computed(() => {
    const loan = this.workflow.loan();
    const request = this.current();
    if (!loan || !request) return null;
    const available = availableCredit(loan);
    return {
      limit: formatMoney(loan.creditLimit),
      balance: formatMoney(loan.balance),
      available: formatMoney(available),
      short: request.type === 'credit_release' && request.amount > available,
    };
  });

  protected readonly eligibility = computed(() => {
    const request = this.current();
    const eligibility = request?.eligibility;
    if (!eligibility) return null;
    return {
      level: eligibility.level,
      summary: ELIGIBILITY_COPY[eligibility.level].summary,
      evaluatedAt: formatDateTime(eligibility.evaluatedAt),
      outcomes: eligibility.outcomes.map((outcome) => ({
        ...outcome,
        ...RULE_LEVEL[outcome.level],
      })),
    };
  });

  /**
   * Buttons, derived from the transition map rather than from status checks.
   * Guard state, in-flight state and the double-submit lock are all folded in
   * here so the template only renders.
   */
  protected readonly actions = computed<ActionView[]>(() => {
    const busy = this.workflow.busy();
    const pending = this.workflow.pending();
    const noteFor = this.noteFor();

    return this.workflow.actionsFor('lender').map((action) => {
      const { to, label, intent, requiresNote } = action.transition;
      const inFlight = pending === to;
      const noteOpen = requiresNote && noteFor === to;
      return {
        to,
        label: inFlight
          ? (IN_FLIGHT[to] ?? 'Working…')
          : noteOpen
            ? `Confirm ${label.toLowerCase()}`
            : label,
        cls: INTENT_CLASS[intent],
        enabled: action.enabled,
        blockedReason: action.blockedReason,
        requiresNote,
        noteOpen,
        // Any command in flight disables every button, not just its own.
        disabled: !action.enabled || busy,
      };
    });
  });

  protected readonly announcement = computed(() => {
    if (this.workflow.loading() || !this.attempted()) return 'Loading request.';
    const request = this.current();
    if (!request) return this.failure().heading;
    return `${TYPE_LABEL[request.type]} ${this.amount()}, ${STATUS_COPY[request.status].label}.`;
  });

  protected readonly noActionCopy = computed(() => {
    const request = this.current();
    if (!request) return '';
    return isTerminal(request.status)
      ? 'This request is complete. No further action is possible.'
      : 'Nothing is waiting on you here — this request is with the borrower.';
  });

  /**
   * The store flattens the API error into a sentence, so the sentence is what we
   * classify against: the contract's own failure constants mean the request may
   * well exist and we simply could not reach it, whereas anything else is the
   * server speaking about this specific id.
   */
  protected readonly failure = computed(() => {
    const notice = this.workflow.notice();
    const message = notice?.message ?? 'That request is not available.';

    if (message === FAILURE_COPY.forbidden) {
      return {
        glyph: '✕',
        glyphClass: 'text-bad',
        heading: 'You do not have access to this request',
        message: 'It belongs to another borrower’s file.',
        retryable: false,
      };
    }

    if (message === FAILURE_COPY.generic || message.startsWith('We could not reach')) {
      return {
        glyph: '!',
        glyphClass: 'text-warn',
        heading: 'This request could not be loaded',
        message,
        retryable: true,
      };
    }

    return {
      glyph: '○',
      glyphClass: 'text-muted',
      heading: 'Request not found',
      message,
      retryable: false,
    };
  });

  // -- Commands -------------------------------------------------------------

  protected run(action: ActionView): void {
    if (action.disabled) return; // the button is disabled, but never trust the view

    // First click reveals the field; the second one commits, once it has content.
    if (action.requiresNote && !action.noteOpen) {
      this.noteFor.set(action.to);
      this.noteError.set(null);
      return;
    }

    if (action.requiresNote) {
      void this.confirmNote();
      return;
    }

    void this.dispatch(action.to);
  }

  private async confirmNote(): Promise<void> {
    const reason = this.noteText().trim();
    if (!reason) {
      this.noteError.set('A reason is required before this request can be declined.');
      return;
    }
    this.noteError.set(null);
    if (await this.workflow.decline(reason)) this.resetNote();
  }

  protected cancelNote(restoreFocusTo?: HTMLButtonElement): void {
    this.resetNote();
    restoreFocusTo?.focus();
  }

  protected onNoteInput(event: Event): void {
    this.noteText.set((event.target as HTMLTextAreaElement).value);
    if (this.noteError()) this.noteError.set(null);
  }

  protected reload(): void {
    void this.workflow.load(this.id());
  }

  /**
   * Named commands, chosen by destination. The store owns legality and the
   * refetch; nothing here moves business state locally.
   */
  private async dispatch(to: RequestStatus): Promise<void> {
    switch (to) {
      case 'under_review':
        await this.workflow.startReview();
        return;
      case 'approved':
        await this.workflow.approve();
        return;
      case 'funded':
        await this.workflow.markFunded();
        return;
      default:
        return; // 'declined' goes through confirmNote(); the rest are not lender moves
    }
  }

  private resetNote(): void {
    this.noteFor.set(null);
    this.noteText.set('');
    this.noteError.set(null);
  }
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const time = date.toLocaleTimeString('en-CA', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${day} · ${time}`;
}
