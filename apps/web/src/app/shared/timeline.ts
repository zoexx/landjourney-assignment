import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { STATUS_COPY, type RequestEvent } from '@lj/contracts';

/**
 * Event timeline.
 *
 * Rendered from `request_events`, which is append-only. History is domain data —
 * it is never reconstructed from the current status, so what is shown here is
 * exactly what was committed, in the order it was committed.
 */
@Component({
  selector: 'app-timeline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ol class="relative">
      @for (item of items(); track item.id; let last = $last) {
        <li class="relative flex gap-3 pb-4 last:pb-0">
          @if (!last) {
            <span aria-hidden="true" class="absolute top-4 bottom-0 left-[7px] w-px bg-line"></span>
          }
          <span
            aria-hidden="true"
            class="relative z-10 mt-1 grid h-[15px] w-[15px] shrink-0 place-items-center rounded-full border bg-surface font-mono text-[8px] leading-none"
            [class]="item.dotClass"
          >{{ item.glyph }}</span>

          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-baseline gap-x-2">
              <span class="text-base font-medium text-ink">{{ item.label }}</span>
              <span class="numeric text-xs text-faint">{{ item.when }}</span>
            </div>
            <div class="text-sm text-muted">{{ item.who }}</div>
            @if (item.note) {
              <p class="mt-1.5 border-l-2 border-line-strong bg-raised py-1.5 pl-2.5 text-sm text-body">{{ item.note }}</p>
            }
          </div>
        </li>
      }
    </ol>
  `,
})
export class Timeline {
  readonly events = input.required<readonly RequestEvent[]>();

  protected readonly items = computed(() =>
    this.events().map((event) => {
      const copy = STATUS_COPY[event.toStatus];
      return {
        id: event.id,
        label: copy.label,
        glyph: copy.glyph,
        dotClass:
          copy.tone === 'ok'
            ? 'border-ok-border text-ok'
            : copy.tone === 'bad'
              ? 'border-bad-border text-bad'
              : copy.tone === 'warn'
                ? 'border-warn-border text-warn'
                : 'border-line-strong text-muted',
        when: formatWhen(event.createdAt),
        who: describeActor(event),
        note: event.note,
      };
    }),
  );
}

function describeActor(event: RequestEvent): string {
  const name = event.actorName;
  if (event.actorRole === 'lender') return name ? `${name} · lender` : 'Lender';
  if (event.actorRole === 'borrower') return name ? `${name} · borrower` : 'Borrower';
  return 'System';
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}
