/**
 * Authentication session.
 *
 * Signals hold the session because it is genuinely client state — who is signed
 * in right now, and whether we have finished finding out. The user's ROLE is not
 * client state: it is read from `profiles` and re-resolved by the API on every
 * request. Nothing here is trusted for authorization; it only decides what to
 * render.
 */

import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { Role } from '@lj/contracts';
import { environment } from '../../environments/environment';

export interface Profile {
  id: string;
  role: Role;
  fullName: string | null;
  email: string | null;
}

@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly router = inject(Router);

  readonly client: SupabaseClient = createClient(
    environment.supabaseUrl,
    environment.supabaseKey,
    { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } },
  );

  private readonly _session = signal<Session | null>(null);
  private readonly _profile = signal<Profile | null>(null);
  /** True until the persisted session has been restored, so guards do not act early. */
  private readonly _restoring = signal(true);

  readonly profile = this._profile.asReadonly();
  readonly restoring = this._restoring.asReadonly();
  readonly signedIn = computed(() => this._session() !== null && this._profile() !== null);
  readonly role = computed<Role | null>(() => this._profile()?.role ?? null);
  readonly isLender = computed(() => this.role() === 'lender');
  readonly displayName = computed(
    () => this._profile()?.fullName ?? this._profile()?.email ?? 'Signed in',
  );

  constructor() {
    void this.restore();

    this.client.auth.onAuthStateChange((_event, session) => {
      this._session.set(session);
      if (!session) {
        this._profile.set(null);
      }
    });
  }

  private async restore(): Promise<void> {
    try {
      const { data } = await this.client.auth.getSession();
      this._session.set(data.session);
      if (data.session) await this.loadProfile();
    } finally {
      this._restoring.set(false);
    }
  }

  private async loadProfile(): Promise<void> {
    const { data: userData } = await this.client.auth.getUser();
    const user = userData.user;
    if (!user) {
      this._profile.set(null);
      return;
    }

    // Role comes from the database, never from user metadata the client could set.
    const { data, error } = await this.client
      .from('profiles')
      .select('id, role, full_name')
      .eq('id', user.id)
      .single();

    if (error || !data) {
      this._profile.set(null);
      return;
    }

    this._profile.set({
      id: data.id as string,
      role: data.role as Role,
      fullName: (data.full_name as string | null) ?? null,
      email: user.email ?? null,
    });
  }

  /** The bearer token sent to the API. Refreshed by supabase-js as needed. */
  async accessToken(): Promise<string | null> {
    const { data } = await this.client.auth.getSession();
    return data.session?.access_token ?? null;
  }

  async signIn(email: string, password: string): Promise<string | null> {
    const { error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) return friendlyAuthError(error.message);
    await this.loadProfile();
    return null;
  }

  async signUp(email: string, password: string, fullName: string): Promise<string | null> {
    const { data, error } = await this.client.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    });
    if (error) return friendlyAuthError(error.message);

    // With email confirmation enabled, signUp returns no session. Try an
    // immediate sign-in so a confirmed account lands straight in the app; if the
    // project still requires a click-through, say so plainly.
    if (!data.session) {
      const signInError = await this.signIn(email, password);
      if (signInError) {
        return 'Your account was created, but this project still requires email confirmation before you can sign in.';
      }
      return null;
    }

    await this.loadProfile();
    return null;
  }

  async signOut(): Promise<void> {
    await this.client.auth.signOut();
    this._profile.set(null);
    this._session.set(null);
    await this.router.navigate(['/sign-in']);
  }

  /** Where a signed-in user belongs, decided by role. */
  homeRoute(): string {
    return this.isLender() ? '/queue' : '/my-file';
  }
}

function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials')) return 'That email and password do not match.';
  if (m.includes('email address') && m.includes('invalid')) {
    return 'That email address was rejected. Try a different domain.';
  }
  if (m.includes('rate limit')) {
    return 'Too many attempts just now. Wait a minute and try again.';
  }
  if (m.includes('already registered') || m.includes('already been registered')) {
    return 'An account already exists for that email. Try signing in instead.';
  }
  if (m.includes('password')) return 'That password is too short — use at least 6 characters.';
  return message;
}
