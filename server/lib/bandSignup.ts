import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { bandMembers, bands } from '../db/schema.js';

/** Who may create band invite links that let newcomers sign up — a per-band, admin-set policy. */
export type MemberSignupPolicy = 'none' | 'owner' | 'editors';

export const MEMBER_SIGNUP_POLICIES: readonly MemberSignupPolicy[] = ['none', 'owner', 'editors'];

export function isMemberSignupPolicy(value: unknown): value is MemberSignupPolicy {
  return typeof value === 'string' && (MEMBER_SIGNUP_POLICIES as readonly string[]).includes(value);
}

/**
 * Whether `userId` may create (or, as a link's creator, still stand behind) a band invite link
 * that lets newcomers create an account, under the band's current policy. Checked again whenever
 * such a link is used, so tightening the policy or demoting the creator disables links already out.
 */
export async function canInviteWithSignup(bandId: string, userId: string): Promise<boolean> {
  const [band] = await db
    .select({ ownerId: bands.ownerId, memberSignup: bands.memberSignup })
    .from(bands)
    .where(eq(bands.id, bandId))
    .limit(1);
  if (!band || band.memberSignup === 'none') return false;
  if (band.ownerId === userId) return true;
  if (band.memberSignup !== 'editors') return false;
  const [member] = await db
    .select({ role: bandMembers.role })
    .from(bandMembers)
    .where(and(eq(bandMembers.bandId, bandId), eq(bandMembers.userId, userId)))
    .limit(1);
  return member?.role === 'editor';
}
