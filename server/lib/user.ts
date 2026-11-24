import type { users } from '../db/schema.js';
import { resolveStorageQuotaBytes } from './storageQuota.js';
import { sanitizeUserPreferences, type UserPreferences } from './userPreferences.js';

type UserRow = typeof users.$inferSelect;

export interface PublicUser {
  id: string;
  email: string;
  username: string | null;
  avatar: string | null;
  fullName: string | null;
  role: 'member' | 'admin';
  storageQuotaBytes: number;
  preferences: UserPreferences;
  /** Whether the account has a password set (accounts may sign in by passkey or email only). */
  hasPassword: boolean;
  /** Whether this user may create new bands (see `ANYONE_CAN_CREATE_BANDS`). */
  canCreateBands: boolean;
}

/**
 * `ANYONE_CAN_CREATE_BANDS` (default true): when false, only site admins can create bands;
 * everyone else joins bands through invite links. Read per call so tests can vary it.
 */
export function anyoneCanCreateBands(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.ANYONE_CAN_CREATE_BANDS?.trim().toLowerCase();
  if (!raw || raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`ANYONE_CAN_CREATE_BANDS must be "true" or "false" (got "${env.ANYONE_CAN_CREATE_BANDS}").`);
}

export function canCreateBands(role: string): boolean {
  return role === 'admin' || anyoneCanCreateBands();
}

/** Self-host builds have no billing/plan concept — every user gets full feature access, aside
 * from the admin-assignable storage quota (see server/lib/storageQuota.ts). */
export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    avatar: row.avatar,
    fullName: row.fullName,
    role: row.role === 'admin' ? 'admin' : 'member',
    storageQuotaBytes: resolveStorageQuotaBytes(row.storageQuotaBytes),
    preferences: sanitizeUserPreferences(row.preferences),
    hasPassword: Boolean(row.passwordHash),
    canCreateBands: canCreateBands(row.role),
  };
}
