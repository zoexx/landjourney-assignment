import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { STATUS_COPY, type RequestStatus, type Tone } from '@lj/contracts';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'border-line-strong bg-subtle text-body',
  info: 'border-navy-border bg-navy-bg text-navy',
  ok: 'border-ok-border bg-ok-bg text-ok',
  warn: 'border-warn-border bg-warn-bg text-warn',
  bad: 'border-bad-border bg-bad-bg text-bad',
};

/**
 * Status badge. The glyph is not decoration — colour is never the only signal,
 * so the badge stays readable in greyscale and to anyone who cannot distinguish
 * the hues.
 */
@Component({
  selector: 'app-status-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="inline-flex items-center gap-1.5 border px-1.5 py-0.5 font-mono text-2xs font-medium tracking-[0.08em] uppercase"
      [class]="toneClass()"
    >
      <span aria-hidden="true">{{ copy().glyph }}</span>
      <span>{{ copy().label }}</span>
    </span>
  `,
})
export class StatusBadge {
  readonly status = input.required<RequestStatus>();
  protected readonly copy = computed(() => STATUS_COPY[this.status()]);
  protected readonly toneClass = computed(() => TONE_CLASS[this.copy().tone]);
}
