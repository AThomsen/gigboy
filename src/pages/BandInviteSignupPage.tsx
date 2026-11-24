import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import InviteSignupForm, { AuthCard } from '../components/InviteSignupForm';
import { useAuth } from '../context/AuthContext';
import { dataClient } from '../lib/dataClient';
import type { BandInviteContext } from '../lib/dataClient/types';
import { clearPendingBandInvite, savePendingBandInvite } from '../lib/pendingBandInvite';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

type LookupState =
  | { status: 'loading' }
  | { status: 'invalid'; message: string }
  | { status: 'valid'; invite: BandInviteContext };

/**
 * Where a signed-out visitor lands from a band invite link (`/band-invite/:id/signup`). If the
 * link allows it, they create an account and join the band in one step; otherwise — or if they
 * already have an account — they sign in, and the remembered invite resumes afterwards.
 */
export default function BandInviteSignupPage() {
  const { inviteId = '' } = useParams<{ inviteId: string }>();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [lookup, setLookup] = useState<LookupState>({ status: 'loading' });
  // Set once sign-up succeeds; also keeps the signed-in redirect below from firing while the form
  // still shows its passkey step.
  const [signingUp, setSigningUp] = useState(false);
  const joinedBandId = useRef<string | null>(null);
  useDocumentTitle(lookup.status === 'valid' ? `Join ${lookup.invite.bandName}` : 'Join band');

  // Signing in instead of signing up should still land on the invite afterwards.
  useEffect(() => {
    if (inviteId) savePendingBandInvite(inviteId);
  }, [inviteId]);

  useEffect(() => {
    if (!inviteId) {
      setLookup({ status: 'invalid', message: 'This invite link is missing its invite ID.' });
      return;
    }
    let cancelled = false;
    void dataClient.bands.getInvite(inviteId).then(({ invite, error }) => {
      if (cancelled) return;
      if (invite) {
        setLookup({ status: 'valid', invite });
      } else {
        // A dead link shouldn't bounce the visitor back here after they sign in.
        clearPendingBandInvite();
        setLookup({ status: 'invalid', message: error ?? 'This invite is no longer valid.' });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [inviteId]);

  // Signed in already (and not mid-signup — the form keeps its own screen until it's done).
  if (user && !signingUp) return <Navigate to={`/band-invite/${inviteId}`} replace />;

  if (lookup.status === 'loading' || authLoading) {
    return (
      <AuthCard>
        <p>Checking your invite&hellip;</p>
      </AuthCard>
    );
  }

  if (lookup.status === 'invalid') {
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
        <p className="login-description">{lookup.message}</p>
      </AuthCard>
    );
  }

  const { invite } = lookup;
  // Links for existing accounts only: straight to sign-in, as before sign-up links existed.
  if (!invite.allowSignup) return <Navigate to="/" replace />;

  const finish = () => {
    clearPendingBandInvite();
    const bandId = joinedBandId.current;
    if (!bandId) {
      navigate('/', { replace: true });
      return;
    }
    try {
      window.localStorage.setItem('gigboy-active-band-id', bandId);
    } catch {
      // Ignore localStorage failures.
    }
    navigate(`/bands/${bandId}/library`, { replace: true, state: { bandId } });
  };

  return (
    <InviteSignupForm
      title={`Join ${invite.bandName}`}
      description={
        invite.inviterName
          ? `${invite.inviterName} invited you to join ${invite.bandName} on Gigboy. Create your account below.`
          : `You've been invited to join ${invite.bandName} on Gigboy. Create your account below.`
      }
      pinnedEmail={null}
      submit={async (input) => {
        setSigningUp(true);
        const result = await dataClient.bands.signUpWithInvite(inviteId, input);
        if (!result.user) setSigningUp(false);
        joinedBandId.current = result.bandId;
        return result;
      }}
      onDone={finish}
      signInPrompt={<>Already have an account? <Link to="/">Sign in</Link> to join the band.</>}
    />
  );
}
