import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import InviteSignupForm, { AuthCard } from '../components/InviteSignupForm';
import { useAuth } from '../context/AuthContext';
import { dataClient } from '../lib/dataClient';
import type { InviteContext } from '../lib/dataClient/types';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

type LookupState =
  | { status: 'loading' }
  | { status: 'invalid'; message: string }
  | { status: 'valid'; invite: InviteContext };

export default function AcceptInvitePage() {
  useDocumentTitle('Accept invite');
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { loading: authLoading } = useAuth();
  const [lookup, setLookup] = useState<LookupState>({ status: 'loading' });

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

  if (lookup.status === 'loading' || authLoading) {
    return (
      <AuthCard>
        <p>Checking your invite&hellip;</p>
      </AuthCard>
    );
  }

  if (lookup.status === 'invalid' || !token) {
    return (
      <AuthCard
        footer={
          <footer className="footer">
            <span className="footer-links">
              <Link to="/">Go to sign in</Link>
            </span>
          </footer>
        }
      >
        <h1 className="login-title">Invite unavailable</h1>
        <p className="login-description">
          {lookup.status === 'invalid' ? lookup.message : 'This invite link is missing a token.'}
        </p>
      </AuthCard>
    );
  }

  const { email } = lookup.invite;
  return (
    <InviteSignupForm
      title="Join GIGBOY"
      description={
        email
          ? `You've been invited as ${email}. Create your account below.`
          : "You've been invited to join. Create your account below."
      }
      pinnedEmail={email}
      submit={(input) => dataClient.auth.acceptInvite(token, input)}
      // "/" resolves to the user's last active band (or profile if they have none) via
      // RootRedirect, same destination a fresh login lands on — no deep link to preserve here.
      onDone={() => navigate('/', { replace: true })}
      signInPrompt={<>Already have an account? <Link to="/">Sign in</Link></>}
    />
  );
}
