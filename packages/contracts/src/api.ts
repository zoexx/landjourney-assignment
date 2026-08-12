/**
 * API error vocabulary.
 *
 * Shared by both runtimes: the server produces these codes, the client branches
 * on them. Deliberately carries no runtime dependency, so importing it costs the
 * browser nothing — the zod schemas live in `./schemas.ts` behind a subpath.
 */

/**
 * Machine-readable failure codes. The UI branches on these rather than on
 * message text — notably to tell a stale-version conflict apart from a generic
 * failure, which get very different copy.
 */
export const API_ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'not_found',
  'validation_failed',
  'illegal_transition',
  'stale_version',
  'guard_failed',
  'internal',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Present on `illegal_transition`: names the move that was attempted. */
    attempted?: { from: string; to: string };
    /** Present on `stale_version`. */
    currentVersion?: number;
    /** Present on `validation_failed`. */
    fields?: { key: string; message: string }[];
  };
}

export const HTTP_STATUS_FOR: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  illegal_transition: 409,
  stale_version: 409,
  guard_failed: 409,
  internal: 500,
};
