import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ELIGIBILITY_COPY, type EligibilityLevel } from '@lj/contracts';

const LEVEL = {
  green: { cls: 'border-ok-border bg-ok-bg text-ok', glyph: '✓' },
  amber: { cls: 'border-warn-border bg-warn-bg text-warn', glyph: '!' },
  red: { cls: 'border-bad-border bg-bad-bg text-bad', glyph: '✕' },
} as const satisfies Record<EligibilityLevel, { cls: string; glyph: string }>;

/** Eligibility roll-up. Same glyph-plus-word rule as the status badge. */
@Component({
  selector: 'app-eligibility-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="inline-flex items-center gap-1.5 border px-1.5 py-0.5 font-mono text-2xs font-medium tracking-[0.08em] uppercase"
      [class]="style().cls"
    >
      <span aria-hidden="true">{{ style().glyph }}</span>
      <span>{{ label() }}</span>
    </span>
  `,
})
export class EligibilityBadge {
  readonly level = input.required<EligibilityLevel>();
  protected readonly style = computed(() => LEVEL[this.level()]);
  protected readonly label = computed(() => ELIGIBILITY_COPY[this.level()].label);
}
