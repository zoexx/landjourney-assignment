/**
 * The application form.
 *
 * Nothing about this screen knows what an agricultural lending application asks
 * for. The steps, the fields, the bounds and the eligibility rules all arrive as
 * data from `GET /api/form-schema`; the renderer switches on `field.type` and
 * the validators come out of `validatePayload`. Adding a question to the form is
 * a row in `form_schemas`, not a commit here.
 *
 * Three decisions worth stating up front:
 *
 *   - The draft lives in Postgres, not in this component and not in
 *     localStorage. Every change is debounced into `PATCH /draft`, which stores
 *     the payload AND the step. A hard refresh mid-form is a re-read, not a
 *     recovery.
 *   - Eligibility is evaluated in the browser on every keystroke for feedback,
 *     and again on the server on every autosave for truth. Same pure function,
 *     two runtimes — and the panel says which one the lender acts on.
 *   - An untouched field is never shown an error. The form is being filled in,
 *     not marked.
 */

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  ELIGIBILITY_COPY,
  FAILURE_COPY,
  STATUS_COPY,
  evaluateEligibility,
  formatMoney,
  parseMoneyToCents,
  requiredFieldKeys,
  validatePayload,
  type CreditRequest,
  type EligibilityLevel,
  type FormField,
  type FormSchema,
} from '@lj/contracts';
import { Api, ApiFailure } from '../core/api';
import { EligibilityBadge } from '../shared/eligibility-badge';
import { Notice } from '../shared/notice';
import { describe } from '../shared/workflow';

/** Long enough not to PATCH per keystroke, short enough that "Saved" feels true. */
const AUTOSAVE_MS = 800;

/** `/apply/new` has no draft behind it yet, so this page creates one and swaps the URL. */
const NEW_DRAFT = 'new';

/** Per-rule glyph + word. Colour is never the only signal. */
const RULE_LEVEL: Record<EligibilityLevel, { glyph: string; cls: string; spoken: string }> = {
  green: { glyph: '✓', cls: 'text-ok', spoken: 'Within policy' },
  amber: { glyph: '!', cls: 'text-warn', spoken: 'Outside preference' },
  red: { glyph: '✕', cls: 'text-bad', spoken: 'Outside policy' },
};

const INPUT_BASE =
  'w-full border bg-surface px-2.5 py-2 text-base text-ink outline-none focus:border-navy disabled:bg-sunken';

/**
 * One field, rendered from its schema entry.
 *
 * Exported only because Angular's template type-checker cannot import a symbol
 * that is not; it belongs to this file and nothing else references it.
 *
 * It switches on `type` and on nothing else — no branch in this file knows that
 * a field is called `acreage`. Money is the single modifier: it is typed in
 * dollars and stored as integer cents, so the parse happens here and everything
 * downstream — payload, autosave, eligibility, the amount column — only ever
 * sees cents.
 */
@Component({
  selector: 'app-dynamic-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div>
      <label class="label-micro mb-1.5 flex flex-wrap items-baseline gap-x-2" [attr.for]="controlId()">
        <span>{{ field().label }}</span>
        @if (field().required !== true) {
          <span class="text-faint">Optional</span>
        }
      </label>

      <!--
        The whole renderer. There is no @default: FieldType is a closed union, and
        quietly falling back to a text box would invent an input the lender never
        published.
      -->
      @switch (field().type) {
        @case ('text') {
          <input
            [id]="controlId()"
            type="text"
            [attr.placeholder]="field().placeholder ?? null"
            [attr.maxlength]="field().maxLength ?? null"
            [attr.aria-invalid]="problem() !== null"
            [attr.aria-describedby]="describedBy()"
            [ngModel]="value() ?? ''"
            (ngModelChange)="commit($event)"
            (blur)="touched.emit()"
            [ngModelOptions]="{ standalone: true }"
            [disabled]="disabled()"
            [class]="inputClass()"
          />
        }

        @case ('number') {
          @if (field().money === true) {
            <!-- Dollars in, cents out. The prefix is decoration; the parse is real. -->
            <div class="relative">
              <span aria-hidden="true" class="numeric absolute top-1/2 left-2.5 -translate-y-1/2 text-muted">$</span>
              <input
                [id]="controlId()"
                type="text"
                inputmode="decimal"
                autocomplete="off"
                [attr.placeholder]="field().placeholder ?? '25,000'"
                [attr.aria-invalid]="problem() !== null"
                [attr.aria-describedby]="describedBy()"
                [ngModel]="dollars()"
                (ngModelChange)="commitMoney($event)"
                (blur)="touched.emit()"
                [ngModelOptions]="{ standalone: true }"
                [disabled]="disabled()"
                [class]="moneyClass()"
              />
            </div>
          } @else {
            <input
              [id]="controlId()"
              type="number"
              [attr.min]="field().min ?? null"
              [attr.max]="field().max ?? null"
              [attr.placeholder]="field().placeholder ?? null"
              [attr.aria-invalid]="problem() !== null"
              [attr.aria-describedby]="describedBy()"
              [ngModel]="value() ?? null"
              (ngModelChange)="commit($event)"
              (blur)="touched.emit()"
              [ngModelOptions]="{ standalone: true }"
              [disabled]="disabled()"
              [class]="numericClass()"
            />
          }
        }

        @case ('select') {
          <select
            [id]="controlId()"
            [attr.aria-invalid]="problem() !== null"
            [attr.aria-describedby]="describedBy()"
            [ngModel]="value() ?? ''"
            (ngModelChange)="commit($event)"
            (blur)="touched.emit()"
            [ngModelOptions]="{ standalone: true }"
            [disabled]="disabled()"
            [class]="inputClass()"
          >
            <!-- An unanswered question is blank, not the first option by accident. -->
            <option value="">Select…</option>
            @for (option of field().options ?? []; track option) {
              <option [value]="option">{{ option }}</option>
            }
          </select>
        }

        @case ('textarea') {
          <textarea
            [id]="controlId()"
            rows="4"
            [attr.placeholder]="field().placeholder ?? null"
            [attr.maxlength]="field().maxLength ?? null"
            [attr.aria-invalid]="problem() !== null"
            [attr.aria-describedby]="describedBy()"
            [ngModel]="value() ?? ''"
            (ngModelChange)="commit($event)"
            (blur)="touched.emit()"
            [ngModelOptions]="{ standalone: true }"
            [disabled]="disabled()"
            [class]="areaClass()"
          ></textarea>
        }
      }

      @if (hint(); as text) {
        <p [id]="hintId()" class="mt-1.5 text-sm text-muted">{{ text }}</p>
      }

      @if (problem(); as message) {
        <p [id]="errorId()" class="mt-1.5 flex items-start gap-1.5 text-sm text-bad-deep">
          <span aria-hidden="true" class="font-mono">✕</span>{{ message }}
        </p>
      }
    </div>
  `,
})
export class DynamicField {
  readonly field = input.required<FormField>();
  /** Whatever the payload holds for this key — cents for money, absent when unanswered. */
  readonly value = input<unknown>();
  /** Schema-derived, supplied by the page. This component never decides validity. */
  readonly error = input<string | null>(null);
  readonly disabled = input(false);

  readonly valueChange = output<unknown>();
  readonly touched = output<void>();

  /** Field keys are unique across the schema, so they make stable, readable ids. */
  protected readonly controlId = computed(() => `field-${this.field().key}`);
  protected readonly hintId = computed(() => `${this.controlId()}-hint`);
  protected readonly errorId = computed(() => `${this.controlId()}-error`);

  /**
   * The dollars the borrower is actually typing.
   *
   * It reseeds from the payload — that is how a resumed draft fills in — but it
   * ignores the echo of the value this field just produced, so autosave cannot
   * reformat a half-typed number under the caret.
   */
  protected readonly dollars = linkedSignal<unknown, string>({
    source: () => this.value(),
    computation: (value, previous) =>
      previous !== undefined && parseMoneyToCents(previous.value) === centsOf(value)
        ? previous.value
        : dollarsOf(value),
  });

  private readonly moneyCents = computed(() => parseMoneyToCents(this.dollars().trim()));

  /**
   * Parse feedback, not validation: it belongs to the money WIDGET, not to any
   * one field. Unparseable text never reaches the payload, so the schema's own
   * validator would otherwise have nothing to complain about.
   */
  private readonly moneyProblem = computed(() =>
    this.field().money === true && this.dollars().trim() !== '' && this.moneyCents() === null
      ? 'Enter an amount in dollars, for example 25,000.'
      : null,
  );

  protected readonly problem = computed(() => this.error() ?? this.moneyProblem());

  /**
   * One class binding per control, never a static class alongside a bound one:
   * two class bindings on an element fight over the same slot.
   */
  protected readonly inputClass = computed(
    () => `${INPUT_BASE} ${this.problem() !== null ? 'border-bad-border' : 'border-line-strong'}`,
  );
  protected readonly numericClass = computed(() => `${this.inputClass()} numeric`);
  protected readonly moneyClass = computed(() => `${this.inputClass()} numeric pl-6`);
  protected readonly areaClass = computed(() => `${this.inputClass()} resize-y`);

  /** The lender's help text, and for money an echo of what we actually stored. */
  protected readonly hint = computed<string | null>(() => {
    const field = this.field();
    const parts: string[] = [];
    if (field.money === true) {
      const cents = this.moneyCents();
      if (cents !== null && this.dollars().trim() !== '') parts.push(formatMoney(cents));
    }
    if (field.help) parts.push(field.help);
    return parts.length > 0 ? parts.join(' · ') : null;
  });

  protected readonly describedBy = computed(() => {
    const ids: string[] = [];
    if (this.hint() !== null) ids.push(this.hintId());
    if (this.problem() !== null) ids.push(this.errorId());
    return ids.length > 0 ? ids.join(' ') : null;
  });

  protected commit(raw: unknown): void {
    this.valueChange.emit(isBlank(raw) ? null : raw);
  }

  protected commitMoney(text: string): void {
    this.dollars.set(text);
    // Null when blank OR unparseable: the draft holds cents or holds nothing.
    this.valueChange.emit(parseMoneyToCents(text.trim()));
  }
}

@Component({
  selector: 'app-application',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DynamicField, EligibilityBadge, Notice],
  template: `
    <div class="mx-auto max-w-[1400px] px-6 py-6">
      <a routerLink="/my-file" class="label-micro !text-navy hover:underline">
        <span aria-hidden="true">←</span> My file
      </a>

      @if (loading()) {
        <!-- Structure only. No step title, no field, no verdict — nothing invented. -->
        <div aria-hidden="true" class="mt-3">
          <div class="panel space-y-3 p-5">
            <span class="block h-2.5 w-28 animate-pulse bg-sunken"></span>
            <span class="block h-6 w-72 animate-pulse bg-sunken"></span>
          </div>
          <div class="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
            <div class="panel space-y-5 p-4">
              @for (slot of SKELETON; track slot) {
                <div class="space-y-2">
                  <span class="block h-2 w-24 animate-pulse bg-sunken"></span>
                  <span class="block h-9 w-full animate-pulse bg-subtle"></span>
                </div>
              }
            </div>
            <div class="panel space-y-3 p-4">
              <span class="block h-2.5 w-20 animate-pulse bg-sunken"></span>
              @for (slot of SKELETON; track slot) {
                <span class="block h-2.5 w-full animate-pulse bg-sunken"></span>
              }
            </div>
          </div>
        </div>
      } @else if (notFound()) {
        <!-- Distinct from a failure: we reached the server and it has no such draft. -->
        <section class="panel mt-3 px-6 py-12 text-center">
          <p aria-hidden="true" class="font-mono text-md text-warn">!</p>
          <h1 class="mt-2 text-md">No application here</h1>
          <p class="mx-auto mt-1 max-w-[40rem] text-base text-body">
            There is no draft application behind this link. It may belong to another file, or it may
            already have been submitted from another device.
          </p>
          <a
            routerLink="/my-file"
            class="mt-4 inline-block border border-line-strong bg-surface px-3 py-1.5 text-base font-medium !text-body transition-colors hover:bg-sunken hover:!text-ink hover:no-underline"
          >Back to my file</a>
        </section>
      } @else if (loadError(); as message) {
        <section class="panel mt-3 p-4">
          <app-notice tone="bad">{{ message }}</app-notice>
          <div class="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              (click)="retry()"
              class="border border-line-strong bg-surface px-3 py-1.5 text-base font-medium text-body transition-colors hover:bg-sunken hover:text-ink"
            >Try again</button>
            <a
              routerLink="/my-file"
              class="border border-line-strong bg-surface px-3 py-1.5 text-base font-medium !text-body transition-colors hover:bg-sunken hover:!text-ink hover:no-underline"
            >Back to my file</a>
          </div>
        </section>
      } @else if (locked(); as locked) {
        <!-- The file is real and theirs; it has just stopped being editable. -->
        <section class="panel mt-3 px-6 py-12 text-center">
          <p aria-hidden="true" class="font-mono text-md text-navy">i</p>
          <h1 class="mt-2 text-md">{{ locked.heading }}</h1>
          <p class="mx-auto mt-1 max-w-[40rem] text-base text-body">{{ locked.message }}</p>
          <a
            [routerLink]="['/requests', id()]"
            class="mt-4 inline-block border border-navy bg-navy px-3 py-1.5 text-base font-medium !text-white transition-colors hover:bg-navy-hover hover:no-underline"
          >View this request</a>
        </section>
      } @else if (currentStep(); as step) {
        <header class="mt-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-line pb-4">
          <div>
            <h1 class="text-xl">{{ formName() }}</h1>
            <p class="mt-0.5 max-w-[62ch] text-base text-body">
              Your answers are saved as you go. You can close this and pick it up later on any
              device.
            </p>
          </div>
          <p class="label-micro">Draft <span class="numeric">{{ reference() }}</span></p>
        </header>

        <div class="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
          <div>
            <!--
              Step indicator and navigation in one control: borrowers correct an
              earlier answer far more often than they walk the form end to end.
            -->
            <nav aria-label="Application steps" class="mb-3 flex flex-wrap">
              @for (marker of stepBar(); track marker.id) {
                <button
                  type="button"
                  (click)="goTo(marker.index)"
                  [attr.aria-current]="marker.current ? 'step' : null"
                  class="-ml-px inline-flex items-center gap-1.5 border px-2.5 py-1 font-mono text-xs font-medium transition-colors first:ml-0"
                  [class]="marker.current ? SELECTED : UNSELECTED"
                >
                  <span class="numeric opacity-70">{{ marker.number }}</span>
                  <span>{{ marker.title }}</span>
                  @if (marker.flagged) {
                    <span aria-hidden="true" [class]="marker.current ? 'text-white' : 'text-warn'">!</span>
                    <span class="sr-only">— needs attention</span>
                  }
                </button>
              }
            </nav>

            <section class="panel" aria-labelledby="step-heading">
              <div class="panel-header flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <div>
                  <span class="label-micro">Step {{ stepIndex() + 1 }} of {{ steps().length }}</span>
                  <h2 #stepHeading id="step-heading" tabindex="-1" class="mt-1 text-md">
                    {{ step.title }}
                  </h2>
                </div>
                <!-- The only claim this screen makes about persistence. -->
                <p class="numeric text-xs" aria-live="polite" [class]="saveTone()">{{ saveState() }}</p>
              </div>

              @if (step.description) {
                <p class="border-b border-line-light px-4 py-2.5 text-base text-body">
                  {{ step.description }}
                </p>
              }

              <div class="space-y-4 p-4">
                @for (field of step.fields; track field.key) {
                  <app-dynamic-field
                    [field]="field"
                    [value]="payload()[field.key]"
                    [error]="visibleErrors().get(field.key) ?? null"
                    [disabled]="submitting()"
                    (valueChange)="setValue(field.key, $event)"
                    (touched)="markTouched(field.key)"
                  />
                }
              </div>

              @if (saveError(); as message) {
                <!-- Warn, not bad: what is on screen is intact, it is the copy in Postgres that lags. -->
                <div class="border-t border-line-light p-4">
                  <app-notice tone="warn">{{ message }}</app-notice>
                </div>
              }

              <div class="flex flex-wrap items-center justify-between gap-3 border-t border-line-light px-4 py-3">
                <button
                  type="button"
                  (click)="back()"
                  [disabled]="stepIndex() === 0"
                  class="border border-line-strong bg-surface px-3 py-2 text-base font-medium text-body transition-colors hover:bg-sunken hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                >Back</button>

                @if (onLastStep()) {
                  <div class="flex flex-wrap items-center gap-3">
                    @if (blockedSummary(); as summary) {
                      <span class="text-sm text-muted">{{ summary }}</span>
                    }
                    <button
                      type="button"
                      (click)="submitApplication()"
                      [disabled]="submitting()"
                      class="border border-navy bg-navy px-4 py-2 text-base font-medium text-white transition-colors hover:bg-navy-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >{{ submitting() ? 'Submitting…' : 'Submit application' }}</button>
                  </div>
                } @else {
                  <button
                    type="button"
                    (click)="next()"
                    class="border border-navy bg-navy px-4 py-2 text-base font-medium text-white transition-colors hover:bg-navy-hover"
                  >Next</button>
                }
              </div>
            </section>

            @if (submitError(); as message) {
              <div class="mt-3"><app-notice tone="bad">{{ message }}</app-notice></div>
            }

            @if (showOutstanding()) {
              <!--
                Shown, never hidden: a borrower must not have to guess why the
                button did nothing, and each line goes to where the answer lives.
              -->
              <section class="panel mt-3" aria-labelledby="outstanding-heading">
                <div class="panel-header">
                  <h2 id="outstanding-heading" class="label-micro">Before this can be submitted</h2>
                </div>
                <ul class="divide-y divide-line-light">
                  @for (item of outstanding(); track item.key) {
                    <li class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-4 py-2">
                      <span aria-hidden="true" class="font-mono text-xs text-warn">!</span>
                      <span class="flex-1 text-base text-ink">{{ item.message }}</span>
                      <button
                        type="button"
                        (click)="goTo(item.stepIndex)"
                        class="label-micro !text-navy hover:underline"
                      >{{ item.stepTitle }} <span aria-hidden="true">→</span></button>
                    </li>
                  }
                </ul>
              </section>
            }
          </div>

          <aside class="lg:sticky lg:top-6">
            @let verdict = eligibility();
            <section class="panel" aria-labelledby="eligibility-heading">
              <div class="panel-header flex items-center justify-between gap-3">
                <h2 id="eligibility-heading" class="label-micro">Eligibility</h2>
                <app-eligibility-badge [level]="verdict.level" />
              </div>

              <!-- Live region: this panel moves while the borrower types, so it must speak. -->
              <div aria-live="polite">
                <p class="px-4 py-2.5 text-base text-body">{{ verdict.summary }}</p>
                @if (verdict.outcomes.length === 0) {
                  <p class="border-t border-line-light px-4 py-2.5 text-base text-muted">
                    Nothing to assess yet. Each rule appears here once you have answered the
                    questions it reads.
                  </p>
                } @else {
                  <ul class="divide-y divide-line-light border-t border-line-light">
                    @for (rule of verdict.outcomes; track rule.key) {
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
                }
              </div>

              <p class="border-t border-line-light px-4 py-2 text-sm text-faint">
                Provisional. Your lender re-computes these rules on the server when the application
                is reviewed, and that verdict is the authoritative one.
              </p>
            </section>
          </aside>
        </div>
      }

      <!--
        Always in the DOM: a live region inserted together with its text is not
        reliably announced, so the region outlives the steps it describes.
      -->
      <p aria-live="polite" class="sr-only">{{ announcement() }}</p>
    </div>
  `,
})
export class ApplicationPage {
  /** Bound from the route by `withComponentInputBinding()`. */
  readonly id = input.required<string>();

  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);

  /** Focus lands here on a step change, so a keyboard user is not left behind. */
  private readonly stepHeading = viewChild<ElementRef<HTMLElement>>('stepHeading');

  protected readonly SELECTED = 'border-navy bg-navy text-white';
  protected readonly UNSELECTED =
    'border-line-strong bg-surface text-body hover:bg-sunken hover:text-ink';
  protected readonly SKELETON = [0, 1, 2];

  // -- State -----------------------------------------------------------------

  private readonly schema = signal<FormSchema | null>(null);
  /** The server's copy of the request: status, version and its own eligibility. */
  private readonly request = signal<CreditRequest | null>(null);
  protected readonly payload = signal<Record<string, unknown>>({});
  protected readonly stepIndex = signal(0);

  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly notFound = signal(false);

  private readonly touched = signal<ReadonlySet<string>>(new Set());
  private readonly submitAttempted = signal(false);

  private readonly dirty = signal(false);
  private readonly saving = signal(false);
  private readonly savedAt = signal<Date | null>(null);
  protected readonly saveError = signal<string | null>(null);
  /** Bumped by every edit; the autosave effect watches this and nothing else. */
  private readonly revision = signal(0);

  protected readonly submitting = signal(false);
  protected readonly submitError = signal<string | null>(null);

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveInFlight: Promise<void> | null = null;

  constructor() {
    // Route → data. The id is the whole input, so a change of it is a different
    // application: every transient signal is re-seeded from the server, not kept.
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });

    // The autosave trigger — the one genuine side effect on this screen. Every
    // keystroke lands here and leaves 800ms later as a PATCH.
    effect(() => {
      if (this.revision() === 0) return; // hydration is not an edit
      untracked(() => this.queueSave());
    });

    // A save scheduled against a component that no longer exists would resolve
    // into nothing; cancel rather than fire it into the dark.
    inject(DestroyRef).onDestroy(() => this.cancelPendingSave());
  }

  // -- Derived presentation --------------------------------------------------

  protected readonly steps = computed(() => this.schema()?.steps ?? []);
  protected readonly currentStep = computed(() => this.steps()[this.stepIndex()] ?? null);
  protected readonly onLastStep = computed(() => this.stepIndex() === this.steps().length - 1);
  protected readonly formName = computed(() => this.schema()?.name ?? 'Application');
  protected readonly reference = computed(() => this.id().slice(0, 8).toUpperCase());

  /** A draft that has moved on, or an id that was never a form at all. */
  protected readonly locked = computed(() => {
    const request = this.request();
    if (!request) return null;
    if (request.type !== 'application') {
      return {
        heading: 'This is not an application',
        message: 'Credit releases are requested from your file and have no form to fill in.',
      };
    }
    if (request.status === 'draft') return null;
    return {
      heading: 'This application is no longer a draft',
      message: STATUS_COPY[request.status].borrower,
    };
  });

  /**
   * Live errors, derived from the schema — there is not one hand-written field
   * rule in this file. Partial while the form is being filled in; once submit
   * has been attempted the required checks join in, because at that point the
   * borrower has asked for the whole thing to be judged.
   */
  private readonly liveErrors = computed(() => {
    const schema = this.schema();
    if (!schema) return [];
    return validatePayload(schema, this.payload(), { partial: !this.submitAttempted() });
  });

  /** The same function at the submit boundary the server uses. */
  private readonly submitErrors = computed(() => {
    const schema = this.schema();
    if (!schema) return [];
    return validatePayload(schema, this.payload(), { partial: false });
  });

  /** An untouched field is not a mistake yet, so it is not shown one. */
  protected readonly visibleErrors = computed(() => {
    const errors = new Map(this.liveErrors().map((error) => [error.key, error.message]));
    if (this.submitAttempted()) return errors;
    const touched = this.touched();
    return new Map([...errors].filter(([key]) => touched.has(key)));
  });

  protected readonly stepBar = computed(() => {
    const current = this.stepIndex();
    const flagged = this.visibleErrors();
    return this.steps().map((step, index) => ({
      id: step.id,
      index,
      number: index + 1,
      title: step.title,
      current: index === current,
      flagged: step.fields.some((field) => flagged.has(field.key)),
    }));
  });

  /**
   * What stands between this draft and a submission. Both halves come from the
   * schema: `requiredFieldKeys` says which answers must exist at all,
   * `validatePayload` with `partial: false` says which are absent or wrong.
   */
  protected readonly outstanding = computed(() => {
    const schema = this.schema();
    if (!schema) return [];

    const required = new Set(requiredFieldKeys(schema));
    const payload = this.payload();
    const where = new Map<string, { index: number; title: string }>();
    schema.steps.forEach((step, index) => {
      for (const field of step.fields) where.set(field.key, { index, title: step.title });
    });

    return this.submitErrors().map((error) => {
      const location = where.get(error.key);
      return {
        key: error.key,
        message: error.message,
        // Unanswered and answered-wrongly read very differently to a borrower.
        unanswered: required.has(error.key) && isBlank(payload[error.key]),
        stepIndex: location?.index ?? 0,
        stepTitle: location?.title ?? '',
      };
    });
  });

  protected readonly showOutstanding = computed(
    () => this.outstanding().length > 0 && (this.onLastStep() || this.submitAttempted()),
  );

  protected readonly blockedSummary = computed(() => {
    const items = this.outstanding();
    if (items.length === 0) return null;
    const missing = items.filter((item) => item.unanswered).length;
    const wrong = items.length - missing;
    const parts: string[] = [];
    if (missing > 0) parts.push(`${missing} ${missing === 1 ? 'answer is' : 'answers are'} still needed`);
    if (wrong > 0) parts.push(`${wrong} ${wrong === 1 ? 'answer needs' : 'answers need'} correcting`);
    return `${parts.join(' and ')}.`;
  });

  /**
   * Live eligibility, evaluated in the browser so the panel keeps up with typing
   * without a request per keystroke. The server runs the same pure function on
   * every autosave and its verdict is the one a lender sees — which is exactly
   * what the note at the foot of the panel says.
   */
  protected readonly eligibility = computed(() => {
    const schema = this.schema();
    const result = evaluateEligibility(
      schema?.rules ?? [],
      this.payload(),
      new Date().toISOString(),
    );
    return {
      level: result.level,
      summary: ELIGIBILITY_COPY[result.level].summary,
      outcomes: result.outcomes.map((outcome) => ({ ...outcome, ...RULE_LEVEL[outcome.level] })),
    };
  });

  protected readonly saveState = computed(() => {
    if (this.saveError() !== null) return 'Not saved';
    if (this.saving()) return 'Saving…';
    if (this.dirty()) return 'Unsaved changes';
    const at = this.savedAt();
    return at ? `Saved ${clock(at)}` : '';
  });

  protected readonly saveTone = computed(() =>
    this.saveError() !== null ? 'text-bad-deep' : 'text-muted',
  );

  protected readonly announcement = computed(() => {
    if (this.loading()) return 'Loading your application.';
    const step = this.currentStep();
    if (!step) return '';
    return `Step ${this.stepIndex() + 1} of ${this.steps().length}, ${step.title}.`;
  });

  // -- Commands --------------------------------------------------------------

  protected retry(): void {
    void this.load(this.id());
  }

  protected setValue(key: string, value: unknown): void {
    this.payload.update((current) => {
      const next = { ...current };
      // An unanswered question is an ABSENT key, not an empty string: absence is
      // what the required-field guard and the eligibility evaluator both read.
      if (isBlank(value)) delete next[key];
      else next[key] = value;
      return next;
    });
    this.dirty.set(true);
    this.revision.update((n) => n + 1);
  }

  protected markTouched(key: string): void {
    if (this.touched().has(key)) return;
    this.touched.update((current) => new Set(current).add(key));
  }

  protected back(): void {
    this.goTo(this.stepIndex() - 1);
  }

  protected next(): void {
    this.goTo(this.stepIndex() + 1);
  }

  protected goTo(index: number): void {
    if (index < 0 || index >= this.steps().length || index === this.stepIndex()) return;

    this.stepIndex.set(index);
    // Where the borrower is up to is persisted state, not view state — it is
    // what a refresh reads back. Written now rather than in 800ms.
    this.dirty.set(true);
    void this.flush();

    // Changing the whole form under a keyboard user without moving focus leaves
    // them tabbing backwards to find the fields that just appeared.
    afterNextRender(() => this.stepHeading()?.nativeElement.focus(), { injector: this.injector });
  }

  protected async submitApplication(): Promise<void> {
    if (this.submitting()) return; // the button is disabled too; never rely on that alone

    // From here on the form is being judged as a whole, so every rule shows.
    this.submitAttempted.set(true);
    this.submitError.set(null);

    const outstanding = this.outstanding();
    const first = outstanding[0];
    if (first) {
      this.goTo(first.stepIndex);
      return;
    }

    const request = this.request();
    if (!request) return;

    this.submitting.set(true);
    try {
      // The server validates the payload it HAS, so the pending edit goes first.
      await this.flush();
      if (this.saveError() !== null) {
        this.submitError.set(
          'Your latest answers have not been saved, so this was not submitted. ' +
            'Check your connection and try again.',
        );
        return;
      }

      const current = this.request() ?? request;
      await this.api.transition(current.id, 'submitted', current.version);
      // The review screen is where a submitted request lives; it states the
      // status the server actually returned rather than one we assumed.
      await this.router.navigate(['/requests', current.id]);
    } catch (failure) {
      if (failure instanceof ApiFailure && failure.isStale) {
        // Something moved this file while it was open. Load the truth, say so.
        await this.refresh();
        this.submitError.set(FAILURE_COPY.stale);
      } else {
        this.submitError.set(describe(failure));
      }
    } finally {
      this.submitting.set(false);
    }
  }

  // -- Data ------------------------------------------------------------------

  private async load(id: string): Promise<void> {
    this.cancelPendingSave();
    this.loading.set(true);
    this.loadError.set(null);
    this.notFound.set(false);

    try {
      if (id === NEW_DRAFT) {
        // The route carries the draft id, so mint one and hand it to the router.
        // The input binding runs this again with the real id; the skeleton stays
        // up across the swap rather than flashing an empty form.
        const created = await this.api.startApplication();
        void this.router.navigate(['/apply', created.request.id], { replaceUrl: true });
        return;
      }

      // One round trip each, in parallel: neither answer depends on the other.
      const [schema, detail] = await Promise.all([
        this.api.formSchema(),
        this.api.requestDetail(id),
      ]);
      this.hydrate(schema, detail.request);
    } catch (failure) {
      if (failure instanceof ApiFailure && failure.code === 'not_found') this.notFound.set(true);
      else this.loadError.set(describe(failure));
    }

    // Deliberately not a finally: the redirect above must leave loading up.
    this.loading.set(false);
  }

  /** Quiet refetch after a conflict — the message is the caller's to set. */
  private async refresh(): Promise<void> {
    try {
      this.request.set((await this.api.requestDetail(this.id())).request);
    } catch {
      /* leave the last known authoritative state on screen */
    }
  }

  private hydrate(schema: FormSchema, request: CreditRequest): void {
    this.schema.set(schema);
    this.request.set(request);
    this.payload.set({ ...request.payload });
    // Resume: land on the step they left, clamped in case the schema has since
    // lost a step. This is the whole point of storing the step server-side.
    this.stepIndex.set(clamp(request.draftStep, 0, schema.steps.length - 1));
    // An answer already in the draft has been touched by definition, so its
    // error is fair to show on the way back in.
    this.touched.set(new Set(Object.keys(request.payload)));
    this.submitAttempted.set(false);
    this.dirty.set(false);
    this.savedAt.set(null);
    this.saveError.set(null);
    this.submitError.set(null);
    this.revision.set(0);
  }

  // -- Autosave --------------------------------------------------------------

  private cancelPendingSave(): void {
    if (this.saveTimer === null) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  private queueSave(): void {
    this.cancelPendingSave();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty()) void this.save();
    }, AUTOSAVE_MS);
  }

  /** Write now rather than in 800ms — before a step change, and before submit. */
  private async flush(): Promise<void> {
    this.cancelPendingSave();
    // A request already in flight left with an older payload, so wait it out and
    // then write whatever has been typed since. Submitting must not race it.
    if (this.saveInFlight !== null) await this.saveInFlight;
    this.cancelPendingSave();
    if (this.dirty()) await this.save();
  }

  private save(): Promise<void> {
    if (this.saveInFlight !== null) {
      // Two PATCHes racing on one row would let the older payload land last.
      // Re-queue instead, so the newest answers are the ones that win.
      this.queueSave();
      return this.saveInFlight;
    }
    const flight = this.write().finally(() => {
      this.saveInFlight = null;
    });
    this.saveInFlight = flight;
    return flight;
  }

  private async write(): Promise<void> {
    const request = this.request();
    if (!request) return;

    this.saving.set(true);
    this.saveError.set(null);
    // Cleared before the await, not after: anything typed during the flight
    // re-dirties this and must still be saved when the flight lands.
    this.dirty.set(false);

    try {
      const saved = await this.api.saveDraft(request.id, this.payload(), this.stepIndex());
      // The response carries the server-recomputed eligibility and the version
      // a submit will be checked against. It never overwrites the payload — the
      // borrower may well have typed since this request left.
      this.request.set(saved);
      this.savedAt.set(new Date());
    } catch (failure) {
      this.dirty.set(true);
      this.saveError.set(describe(failure));
    } finally {
      this.saving.set(false);
    }
  }
}

/** Absent, null or empty — the three ways a question can be unanswered. */
function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** Cents held in the payload, or null when there is nothing usable there. */
function centsOf(value: unknown): number | null {
  if (isBlank(value)) return null;
  const cents = Number(value);
  return Number.isFinite(cents) ? cents : null;
}

/** Cents → the editable dollars string. Whole dollars stay whole. */
function dollarsOf(value: unknown): string {
  const cents = centsOf(value);
  if (cents === null) return '';
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

function clock(at: Date): string {
  return at.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false });
}
