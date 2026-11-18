import { FormEvent, useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { Link, useNavigate, useParams } from 'react-router-dom';
import BrandMark from '../components/BrandMark';
import BrandLogo from '../components/BrandLogo';
import { Button } from '../components/ui/Button';
import { useAuth } from '../context/AuthContext';
import { dataClient } from '../lib/dataClient';
import type { InviteContext } from '../lib/dataClient/types';
import { normalizeUsername, validateUsername } from '../lib/userProfiles';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

type LookupState =
  | { status: 'loading' }
  | { status: 'invalid'; message: string }
  | { status: 'valid'; invite: InviteContext };

export default function AcceptInvitePage() {
  useDocumentTitle('Accept invite');
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { setUser, authMethods, loading: authLoading } = useAuth();
  // Without emailed sign-in, a password is the account's guaranteed way back in.
  const passwordRequired = authMethods.passwords && !authMethods.magicLinks;
  const offerPasskey = authMethods.passkeys && browserSupportsWebAuthn();

  const [lookup, setLookup] = useState<LookupState>({ status: 'loading' });
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(false);

  useEffect(() => {
    if (!token) {
      setLookup({ status: 'invalid', message: 'This invite link is missing a token.' });
      return;
    }

    let cancelled = false;
    void dataClient.auth.getInvite(token).then(({ invite, error: lookupError }) => {
      if (cancelled) return;
      if (invite) {
        setLookup({ status: 'valid', invite });
      } else {
        setLookup({ status: 'invalid', message: lookupError ?? 'This invite is no longer valid.' });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token || lookup.status !== 'valid') return;

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

    if (!lookup.invite.email && !email.includes('@')) {
      setError('A valid email is required.');
      return;
    }

    setBusy(true);
    const { user, error: acceptError } = await dataClient.auth.acceptInvite(token, {
      username: normalizeUsername(username),
      password: passwordRequired ? password : undefined,
      fullName: fullName.trim() || undefined,
      email: lookup.invite.email ? undefined : email.trim(),
    });

    if (acceptError || !user) {
      setError(acceptError ?? 'Failed to accept invite.');
      setBusy(false);
      return;
    }

    setUser(user);
    if (offerPasskey) {
      setBusy(false);
      setCreated(true);
      return;
    }
    // "/" resolves to the user's last active band (or profile if they have none) via
    // RootRedirect, same destination a fresh login lands on — no deep link to preserve here.
    navigate('/', { replace: true });
  }

  if (lookup.status === 'loading' || authLoading) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="login-brand">
            <BrandLogo size={36} />
            <BrandMark size={28} />
          </div>
          <p>Checking your invite&hellip;</p>
        </div>
      </div>
    );
  }

  async function handleAddPasskey() {
    setBusy(true);
    setError('');
    const { passkey, error: passkeyError } = await dataClient.auth.addPasskey();
    if (passkey) {
      navigate('/', { replace: true });
      return;
    }
    setBusy(false);
    if (passkeyError) setError(passkeyError);
  }

  if (created) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="login-brand">
            <BrandLogo size={36} />
            <BrandMark size={28} />
          </div>
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
          <Button type="button" variant="ghost" className="login-submit" onClick={() => navigate('/', { replace: true })} disabled={busy}>
            Skip for now
          </Button>
        </div>
      </div>
    );
  }

  if (lookup.status === 'invalid') {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="login-brand">
            <BrandLogo size={36} />
            <BrandMark size={28} />
          </div>
          <h1 className="login-title">Invite unavailable</h1>
          <p className="login-description">{lookup.message}</p>
          <footer className="footer">
            <span className="footer-links">
              <Link to="/">Go to sign in</Link>
            </span>
          </footer>
        </div>
      </div>
    );
  }

  const needsEmail = !lookup.invite.email;

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-brand">
          <BrandLogo size={36} />
            <BrandMark size={28} />
        </div>
        <h1 className="login-title">Join GIGBOY</h1>
        <p className="login-description">
          {lookup.invite.email
            ? `You've been invited as ${lookup.invite.email}. Create your account below.`
            : "You've been invited to join. Create your account below."}
        </p>

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
          {needsEmail ? (
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

        <p className="login-description">
          Already have an account? <Link to="/">Sign in</Link>
        </p>

        <footer className="footer"><BrandLogo size={14} className="footer-logo" />From Norway {'<3'} with chords</footer>
      </div>
    </div>
  );
}
