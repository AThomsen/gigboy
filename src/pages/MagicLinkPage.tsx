import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import BrandMark from '../components/BrandMark';
import BrandLogo from '../components/BrandLogo';
import { Button } from '../components/ui/Button';
import { useAuth } from '../context/AuthContext';
import { dataClient } from '../lib/dataClient';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

/**
 * Opened from the link in a sign-in email (`/login/link#<token>`). Signing in takes a tap rather
 * than happening on load, so a mail scanner that prefetches the link can't spend it.
 */
export default function MagicLinkPage() {
  useDocumentTitle('Sign in');
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const [token] = useState(() => window.location.hash.replace(/^#/, ''));
  // Drop the token from the address bar so it doesn't linger in history.
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname);
  }, []);
  const [error, setError] = useState(token ? '' : 'This sign-in link is incomplete. Copy the whole link from the email, or use the code instead.');
  const [busy, setBusy] = useState(false);

  async function handleSignIn() {
    setBusy(true);
    setError('');
    const result = await dataClient.auth.verifySignInLink(token);
    if (result.user) {
      try {
        window.localStorage.removeItem('gigboy-pending-email-sign-in');
      } catch {
        // Ignore storage failures.
      }
      setUser(result.user);
      navigate('/', { replace: true });
      return;
    }
    setBusy(false);
    setError(result.error ?? 'Sign-in failed.');
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-brand">
          <BrandLogo size={36} />
          <BrandMark size={28} />
        </div>
        <h1 className="login-title">Sign in to GIGBOY</h1>
        {token && !error && (
          <p className="login-description">Continue to sign in on this device.</p>
        )}
        {error && <p className="login-error">{error}</p>}
        {token && (
          <Button type="button" variant="primary" className="login-submit" onClick={() => void handleSignIn()} disabled={busy}>
            {busy ? 'Signing in...' : 'Sign in'}
          </Button>
        )}
        <p className="login-description">
          Using GIGBOY as an installed app? This link opened in your browser instead. Go back to
          the app and type the 6-digit code from the email there.
        </p>
        <footer className="footer">
          <span className="footer-links">
            <Link to="/">Go to sign in</Link>
          </span>
        </footer>
      </div>
    </div>
  );
}
