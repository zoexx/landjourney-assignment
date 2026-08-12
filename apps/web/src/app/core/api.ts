/**
 * The API client.
 *
 * Two things this deliberately does NOT do:
 *
 *   - It never sends a status as a field. `{ status: 'approved' }` is not a
 *     shape this client can produce. Callers ask for a transition by name.
 *   - It never optimistically applies a business transition. Every command
 *     returns authoritative server state, and that is what gets rendered.
 */

import { Injectable, inject } from '@angular/core';
import type {
  ApiError,
  ApiErrorCode,
  CreditRequest,
  FormSchema,
  Loan,
  QueueRow,
  RequestDetail,
  RequestStatus,
} from '@lj/contracts';
import { environment } from '../../environments/environment';
import { SessionStore } from './session';

/** A failed command, in the shape the UI branches on. */
export class ApiFailure extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly currentVersion?: number,
    readonly attempted?: { from: string; to: string },
    readonly fields?: { key: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiFailure';
  }

  /** Someone else moved this request while we were looking at it. */
  get isStale(): boolean {
    return this.code === 'stale_version';
  }

  /** The move was legal but a domain guard refused it (e.g. credit moved). */
  get isGuard(): boolean {
    return this.code === 'guard_failed';
  }
}

@Injectable({ providedIn: 'root' })
export class Api {
  private readonly session = inject(SessionStore);

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.session.accessToken();
    if (!token) {
      throw new ApiFailure('unauthenticated', 'Your session has expired. Please sign in again.');
    }

    let response: Response;
    try {
      response = await fetch(`${environment.apiBase}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
      });
    } catch {
      // The network failed, so we genuinely do not know whether the command ran.
      // Say exactly that rather than guessing either way.
      throw new ApiFailure(
        'internal',
        'We could not reach the server, so we cannot confirm whether that action completed.',
      );
    }

    if (response.status === 204) return undefined as T;

    const body: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const err = (body as ApiError | null)?.error;
      throw new ApiFailure(
        err?.code ?? 'internal',
        err?.message ?? 'That action did not complete.',
        err?.currentVersion,
        err?.attempted,
        err?.fields,
      );
    }

    return body as T;
  }

  // -- Reads ---------------------------------------------------------------

  formSchema(): Promise<FormSchema> {
    return this.request<FormSchema>('/api/form-schema');
  }

  requests(filter: { status?: RequestStatus; level?: string; type?: string } = {}): Promise<QueueRow[]> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v) params.set(k, String(v));
    const qs = params.toString();
    return this.request<QueueRow[]>(`/api/requests${qs ? `?${qs}` : ''}`);
  }

  requestDetail(id: string): Promise<RequestDetail> {
    return this.request<RequestDetail>(`/api/requests/${id}`);
  }

  myLoan(): Promise<{ loan: Loan | null; requests: QueueRow[] }> {
    return this.request<{ loan: Loan | null; requests: QueueRow[] }>('/api/my-file');
  }

  // -- Commands ------------------------------------------------------------

  createCreditRelease(amount: number, purpose?: string): Promise<RequestDetail> {
    return this.request<RequestDetail>('/api/requests', {
      method: 'POST',
      body: JSON.stringify({ type: 'credit_release', amount, purpose }),
    });
  }

  startApplication(): Promise<RequestDetail> {
    return this.request<RequestDetail>('/api/requests', {
      method: 'POST',
      body: JSON.stringify({ type: 'application' }),
    });
  }

  saveDraft(id: string, payload: Record<string, unknown>, step: number): Promise<CreditRequest> {
    return this.request<CreditRequest>(`/api/requests/${id}/draft`, {
      method: 'PATCH',
      body: JSON.stringify({ payload, step }),
    });
  }

  /**
   * The single status-mutation call. Named commands live on the domain service
   * that wraps this; here there is exactly one door.
   */
  transition(
    id: string,
    to: RequestStatus,
    expectedVersion: number,
    note?: string,
  ): Promise<RequestDetail> {
    return this.request<RequestDetail>(`/api/requests/${id}/transition`, {
      method: 'POST',
      body: JSON.stringify({ to, expectedVersion, note }),
    });
  }
}
