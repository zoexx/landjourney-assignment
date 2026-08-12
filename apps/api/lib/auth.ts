/**
 * Authentication and actor resolution.
 *
 * Every request is executed with a Supabase client bound to the CALLER'S OWN
 * JWT. That is deliberate: row level security then applies to the API exactly as
 * it applies to the browser, so a row RLS would hide is a row this code cannot
 * read either. There is no service-role client anywhere in this app.
 *
 * The actor's role is read from `profiles` on every request. A role is never
 * accepted from the client, in a header, in the body, or from a JWT claim the
 * browser could influence.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Role } from '@lj/contracts';
import type { VercelRequest } from './http.js';

export interface Actor {
  id: string;
  role: Role;
  fullName: string | null;
  /** Supabase client carrying this user's JWT. RLS applies to everything it does. */
  db: SupabaseClient;
}

export type AuthResult =
  | { ok: true; actor: Actor }
  | { ok: false; message: string };

function bearer(req: VercelRequest): string | null {
  const raw = req.headers['authorization'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function clientForToken(token: string): SupabaseClient {
  return createClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_PUBLISHABLE_KEY'),
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}

export async function authenticate(req: VercelRequest): Promise<AuthResult> {
  const token = bearer(req);
  if (!token) return { ok: false, message: 'A bearer token is required.' };

  const db = clientForToken(token);

  // Verifies the JWT against Supabase rather than merely decoding it. A decoded
  // token proves nothing — anyone can write a JSON object.
  const { data: userData, error: userError } = await db.auth.getUser();
  if (userError || !userData.user) {
    return { ok: false, message: 'That session is not valid. Please sign in again.' };
  }

  const { data: profile, error: profileError } = await db
    .from('profiles')
    .select('id, role, full_name')
    .eq('id', userData.user.id)
    .single();

  if (profileError || !profile) {
    return { ok: false, message: 'No profile is provisioned for this account.' };
  }

  return {
    ok: true,
    actor: {
      id: profile.id as string,
      role: profile.role as Role,
      fullName: (profile.full_name as string | null) ?? null,
      db,
    },
  };
}
