/**
 * Request/response plumbing shared by every route.
 *
 * The two Vercel projects sit on different origins, so CORS is configured here
 * from an allow-list rather than a wildcard — a wildcard would also permit
 * credentialed calls from anywhere.
 */

import type { ApiErrorCode } from '@lj/contracts';
import { HTTP_STATUS_FOR } from '@lj/contracts';

export interface VercelRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
}

export interface VercelResponse {
  status(code: number): VercelResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  end(body?: string): void;
}

function allowedOrigins(): string[] {
  return (process.env['WEB_ORIGIN'] ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

export function applyCors(req: VercelRequest, res: VercelResponse): void {
  const origin = typeof req.headers['origin'] === 'string' ? req.headers['origin'] : '';
  const allowed = allowedOrigins();

  // Vercel preview deployments get generated hostnames, so allow the project's
  // own preview domains alongside whatever is configured explicitly.
  const ok =
    allowed.includes(origin) ||
    (origin.endsWith('.vercel.app') && allowed.some((a) => a.endsWith('.vercel.app'))) ||
    (process.env['NODE_ENV'] !== 'production' && origin.startsWith('http://localhost'));

  if (ok && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/** Handles the preflight. Returns true when the request is already answered. */
export function handlePreflight(req: VercelRequest, res: VercelResponse): boolean {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

export interface ErrorDetail {
  attempted?: { from: string; to: string };
  currentVersion?: number;
  fields?: { key: string; message: string }[];
}

export function sendError(
  res: VercelResponse,
  code: ApiErrorCode,
  message: string,
  detail: ErrorDetail = {},
): void {
  res.status(HTTP_STATUS_FOR[code]).json({ error: { code, message, ...detail } });
}

export function sendOk(res: VercelResponse, body: unknown, status = 200): void {
  // Workflow state is never cached — a stale status is worse than a slow one.
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

export function methodNotAllowed(res: VercelResponse, allowed: string[]): void {
  res.setHeader('Allow', allowed.join(', '));
  sendError(res, 'validation_failed', `Method not allowed. Expected ${allowed.join(' or ')}.`);
}

/** Vercel parses JSON bodies already; this tolerates a raw string too. */
export function readJsonBody(req: VercelRequest): unknown {
  if (req.body === undefined || req.body === null) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}
