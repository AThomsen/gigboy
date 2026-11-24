import { FormEvent, ReactNode, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import BrandMark from './BrandMark';
import BrandLogo from './BrandLogo';
import { Button } from './ui/Button';
import { useAuth, type User } from '../context/AuthContext';
import { dataClient } from '../lib/dataClient';
import type { AcceptInviteInput } from '../lib/dataClient/types';
import { normalizeUsername, validateUsername } from '../lib/userProfiles';

/** The centred sign-in card the invite pages are drawn in. */
export function AuthCard({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-brand">
          <BrandLogo size={36} />
          <BrandMark size={28} />
        </div>
        {children}
        {footer}
      </div>
    </div>
  );
}

interface InviteSignupFormProps {
  title: string;
  description: ReactNode;
  /** The email the invite is pinned to; when null the form asks for one. */
  pinnedEmail: string | null;
  /** Creates the account (and signs it in). Called with validated, normalized fields. */
  submit: (input: AcceptInviteInput) => Promise<{ user: User | null; error: string | null }>;
  /** Runs once the account exists — after the optional passkey step. */
  onDone: () => void;
  /** Shown under the form, e.g. a link to sign in instead. */
  signInPrompt: ReactNode;
}

/**
 * Account creation from an invite: username, name, email (unless pinned) and password (when the
 * server needs one), then an offer to add a passkey. Shared by server and band invites.
 */
export default function InviteSignupForm({ title, description, pinnedEmail, submit, onDone, signInPrompt }: InviteSignupFormProps) {
  const { setUser, authMethods } = useAuth();
  // Without emailed sign-in, a password is the account's guaranteed way back in.
  const passwordRequired = authMethods.passwords && !authMethods.magicLinks;
  const offerPasskey = authMethods.passkeys && browserSupportsWebAuthn();

  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    const usernameError = validateUsername(username);
    if (usernameError) {
      setError(usernameError);
      return;
    }

    if (passwordRequired) {
      if (password.length < 8) {
        setError('Password must be at least 8 characters.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
    }

    if (!pinnedEmail && !email.includes('@')) {
      setError('A valid email is required.');
      return;
    }

    setBusy(true);
    const { user, error: acceptError } = await submit({
      username: normalizeUsername(username),
      password: passwordRequired ? password : undefined,
      fullName: fullName.trim() || undefined,
      email: pinnedEmail ? undefined : email.trim(),
    });

    if (acceptError || !user) {
      setError(acceptError ?? 'Failed to create account.');
      setBusy(false);
      return;
    }

    setUser(user);
    if (offerPasskey) {
      setBusy(false);
      setCreated(true);
      return;
    }
    onDone();
  }

  async function handleAddPasskey() {
    setBusy(true);
    setError('');
    const { passkey, error: passkeyError } = await dataClient.auth.addPasskey();
    if (passkey) {
      onDone();
      return;
    }
    setBusy(false);
    if (passkeyError) setError(passkeyError);
  }

  if (created) {
    return (
      <AuthCard>
        <h1 className="login-title">Add a passkey?</h1>
        <p className="login-description">
          Your account is ready. With a passkey you sign in with this device&rsquo;s fingerprint,
          face or screen lock — no password to remember.
          {authMethods.magicLinks && ' You can always sign in with a code sent to your email instead.'}
        </p>
        {error && <p className="login-error">{error}</p>}
        <Button
          type="button"
          variant="primary"
          className="login-submit"
          icon={<KeyRound size={16} aria-hidden="true" />}
          onClick={() => void handleAddPasskey()}
          disabled={busy}
        >
          {busy ? 'Waiting for passkey...' : 'Add a passkey'}
        </Button>
        <Button type="button" variant="ghost" className="login-submit" onClick={onDone} disabled={busy}>
          Skip for now
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      footer={<footer className="footer"><BrandLogo size={14} className="footer-logo" />From Norway {'<3'} with chords</footer>}
    >
      <h1 className="login-title">{title}</h1>
      <p className="login-description">{description}</p>

      <form className="login-form" onSubmit={handleSubmit} noValidate>
        <div className="form-field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => { setUsername(e.target.value); setError(''); }}
            required
          />
        </div>
        <div className="form-field">
          <label htmlFor="fullName">Full name</label>
          <input
            id="fullName"
            type="text"
            autoComplete="name"
            value={fullName}
            onChange={(e) => { setFullName(e.target.value); setError(''); }}
          />
        </div>
        {!pinnedEmail ? (
          <div className="form-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(''); }}
              required
            />
          </div>
        ) : null}
        {passwordRequired && (
          <>
            <div className="form-field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(''); }}
                required
              />
            </div>
            <div className="form-field">
              <label htmlFor="confirm-password">Confirm password</label>
              <input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }}
                required
              />
            </div>
          </>
        )}
        {error && <p className="login-error">{error}</p>}
        <Button type="submit" variant="primary" className="login-submit" disabled={busy}>
          {busy ? 'Creating account...' : 'Create account'}
        </Button>
      </form>

      <p className="login-description">{signInPrompt}</p>
    </AuthCard>
  );
}
