import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { NoticeTone } from './workflow';

const TONE = {
  info: { cls: 'border-navy-border bg-navy-bg text-navy-deep', glyph: 'i' },
  warn: { cls: 'border-warn-border bg-warn-bg text-warn-deep', glyph: '!' },
  bad: { cls: 'border-bad-border bg-bad-bg text-bad-deep', glyph: '✕' },
} as const satisfies Record<NoticeTone, { cls: string; glyph: string }>;

/**
 * Inline notice for conflict and failure copy. Uses role="alert" so a stale
 * conflict is announced rather than silently appearing above the fold.
 */
@Component({
  selector: 'app-notice',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div role="alert" class="flex items-start gap-2 border px-3 py-2.5" [class]="style().cls">
      <span aria-hidden="true" class="font-mono text-xs leading-5">{{ style().glyph }}</span>
      <p class="flex-1 text-sm"><ng-content /></p>
      @if (dismissable()) {
        <button type="button" (click)="dismiss.emit()" class="font-mono text-xs opacity-60 hover:opacity-100" aria-label="Dismiss">✕</button>
      }
    </div>
  `,
})
export class Notice {
  readonly tone = input<NoticeTone>('info');
  readonly dismissable = input(false);
  readonly dismiss = output<void>();
  protected readonly style = computed(() => TONE[this.tone()]);
}
