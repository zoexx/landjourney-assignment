/**
 * Named domain commands.
 *
 * Components call `startReview()` / `approve()` / `decline(reason)` /
 * `markFunded()`. Every one of them funnels into the single transition endpoint.
 * Domain language where the code is read; one guarded path where legality is
 * enforced.
 *
 * This service also owns the failure policy, which is the part that matters:
 *
 *   - a command in flight blocks a second dispatch (double-click protection)
 *   - business state is NEVER moved optimistically
 *   - a stale conflict refetches and says so, rather than retrying blindly
 */

import { Injectable, computed, inject, signal } from '@angular/core';
import {
  FAILURE_COPY,
  availableActions,
  type AvailableAction,
  type GuardContext,
  type RequestDetail,
  type RequestStatus,
  type Role,
} from '@lj/contracts';
import { Api, ApiFailure } from '../core/api';

export type NoticeTone = 'info' | 'warn' | 'bad';

export interface Notice {
  tone: NoticeTone;
  message: string;
}

@Injectable({ providedIn: 'root' })
export class WorkflowStore {
  private readonly api = inject(Api);

  private readonly _detail = signal<RequestDetail | null>(null);
  private readonly _loading = signal(false);
  /** Which transition is in flight, so only that button shows a spinner. */
  private readonly _pending = signal<RequestStatus | null>(null);
  private readonly _notice = signal<Notice | null>(null);

  readonly detail = this._detail.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly pending = this._pending.asReadonly();
  readonly notice = this._notice.asReadonly();
  readonly busy = computed(() => this._pending() !== null);

  readonly request = computed(() => this._detail()?.request ?? null);
  readonly events = computed(() => this._detail()?.events ?? []);
  readonly loan = computed(() => this._detail()?.loan ?? null);

  /** Guard context assembled from authoritative server state only. */
  readonly guardContext = computed<GuardContext | null>(() => {
    const request = this.request();
    if (!request) return null;
    const loan = this.loan();
    return {
      type: request.type,
      amount: request.amount,
      note: null,
      eligibility: request.eligibility,
      payload: request.payload,
      loan: loan ? { creditLimit: loan.creditLimit, balance: loan.balance } : null,
      requiredFields: [],
    };
  });

  /**
   * The actions this actor may take, derived from the transition map rather than
   * from status checks scattered through templates. If the map says a move is
   * illegal, no button for it can exist.
   */
  actionsFor(role: Role): AvailableAction[] {
    const request = this.request();
    const ctx = this.guardContext();
    if (!request || !ctx) return [];
    return availableActions({ from: request.status, role, ctx });
  }

  clearNotice(): void {
    this._notice.set(null);
  }

  async load(id: string): Promise<void> {
    this._loading.set(true);
    try {
      this._detail.set(await this.api.requestDetail(id));
      this._notice.set(null);
    } catch (error) {
      this._detail.set(null);
      this._notice.set({ tone: 'bad', message: describe(error) });
    } finally {
      this._loading.set(false);
    }
  }

  /** Silent refetch used after a conflict — the notice is set by the caller. */
  private async refetch(id: string): Promise<void> {
    try {
      this._detail.set(await this.api.requestDetail(id));
    } catch {
      /* leave the last known authoritative state on screen */
    }
  }

  // -- Named commands -------------------------------------------------------

  startReview(): Promise<boolean> {
    return this.dispatch('under_review');
  }

  approve(): Promise<boolean> {
    return this.dispatch('approved');
  }

  decline(reason: string): Promise<boolean> {
    return this.dispatch('declined', reason);
  }

  markFunded(): Promise<boolean> {
    return this.dispatch('funded');
  }

  /**
   * The one dispatch path.
   *
   * Note what is absent: there is no optimistic status write anywhere. The UI
   * moves only once the server has told us what the state now is.
   */
  private async dispatch(to: RequestStatus, note?: string): Promise<boolean> {
    const request = this.request();
    if (!request) return false;

    // Double-click protection. The buttons are disabled while pending too, but
    // a command must not depend on the view being in the state we expect.
    if (this._pending() !== null) return false;

    this._pending.set(to);
    this._notice.set(null);

    try {
      this._detail.set(
        await this.api.transition(request.id, to, request.version, note),
      );
      return true;
    } catch (error) {
      if (error instanceof ApiFailure && error.isStale) {
        // Somebody else moved it. Load the truth and say so — never retry.
        await this.refetch(request.id);
        this._notice.set({ tone: 'warn', message: FAILURE_COPY.stale });
        return false;
      }

      if (error instanceof ApiFailure && error.isGuard) {
        // A domain guard refused — most often credit moved under an approval.
        await this.refetch(request.id);
        this._notice.set({ tone: 'warn', message: error.message });
        return false;
      }

      this._notice.set({ tone: 'bad', message: describe(error) });
      return false;
    } finally {
      this._pending.set(null);
    }
  }
}

export function describe(error: unknown): string {
  if (error instanceof ApiFailure) {
    if (error.code === 'forbidden') return FAILURE_COPY.forbidden;
    if (error.code === 'internal') return error.message || FAILURE_COPY.generic;
    return error.message;
  }
  return FAILURE_COPY.generic;
}
