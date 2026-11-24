import bcrypt from 'bcrypt';
import { getAuthConfig } from './authConfig.js';

const BCRYPT_ROUNDS = 12;

/** A validated account-creation request, ready to insert into `users`. */
export interface SignupValues {
  email: string;
  emailLower: string;
  username: string;
  passwordHash: string | null;
  fullName: string | null;
}

/**
 * Validates the account fields of an invite-accept body (server invites and band invites share
 * this). `pinnedEmail` wins over any email in the body. Returns an error message for the form, or
 * the values to insert — the password already hashed.
 */
export async function validateSignup(
  body: unknown,
  pinnedEmail: string | null,
): Promise<{ error: string; values?: never } | { error?: never; values: SignupValues }> {
  const { username, password, fullName, email: bodyEmail } = (body ?? {}) as Record<string, unknown>;

  // Without emailed sign-in, a password is the new account's only guaranteed way back in (a
  // passkey can be added after, but not every device can make one), so it's required. With
  // emailed sign-in it's optional, and with passwords off it's not accepted at all.
  const config = getAuthConfig();
  const passwordRequired = config.passwords && !config.magicLinks;
  const passwordGiven = typeof password === 'string' && password.length > 0;
  if (passwordGiven && !config.passwords) return { error: 'Passwords are disabled on this server.' };
  if ((passwordRequired || passwordGiven) && (typeof password !== 'string' || password.length < 8)) {
    return { error: 'Password must be at least 8 characters.' };
  }
  if (typeof username !== 'string' || username.trim().length < 2) {
    return { error: 'Username must be at least 2 characters.' };
  }

  let email: string;
  if (pinnedEmail) {
    email = pinnedEmail;
  } else {
    if (typeof bodyEmail !== 'string' || !bodyEmail.includes('@')) return { error: 'A valid email is required.' };
    email = bodyEmail;
  }

  return {
    values: {
      email: email.trim(),
      emailLower: email.trim().toLowerCase(),
      username: username.trim(),
      passwordHash: passwordGiven ? await bcrypt.hash(password as string, BCRYPT_ROUNDS) : null,
      fullName: typeof fullName === 'string' && fullName.trim() ? fullName.trim() : null,
    },
  };
}

export const DUPLICATE_ACCOUNT_ERROR = 'An account with this email or username already exists.';
