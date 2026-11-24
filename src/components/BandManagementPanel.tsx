import { useState } from 'react';
import { copyText } from '../utils/copyText';
import { Copy, QrCode, Share2, UserPlus } from 'lucide-react';
import toast from '../utils/anchoredToast';
import { useAuth } from '../context/AuthContext';
import { useBands } from '../context/BandsContext';
import UserAvatar from './UserAvatar';
import InviteQrModal from './InviteQrModal';
import { dataClient } from '../lib/dataClient';
import type { Band } from '../types';

interface BandManagementPanelProps {
  band: Band;
  canEditBand: boolean;
  isOwner: boolean;
  showLeaveCurrentUser?: boolean;
  onLeaveCurrentUser?: () => Promise<string | null>;
  onLeaveSuccess?: () => void;
}

export default function BandManagementPanel({
  band,
  canEditBand,
  isOwner,
  showLeaveCurrentUser = false,
  onLeaveCurrentUser,
  onLeaveSuccess,
}: BandManagementPanelProps) {
  const { user } = useAuth();
  const { removeMember } = useBands();

  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [busyInviteLink, setBusyInviteLink] = useState(false);
  const [lastInviteLink, setLastInviteLink] = useState<string | null>(null);
  const [lastInviteLinkExpiresAt, setLastInviteLinkExpiresAt] = useState<string | null>(null);
  const [showInviteQr, setShowInviteQr] = useState(false);
  const [inviteDays, setInviteDays] = useState('7');
  const [inviteAllowSignup, setInviteAllowSignup] = useState(false);
  const [lastInviteAllowsSignup, setLastInviteAllowsSignup] = useState(false);
  // Mirrors server/lib/bandSignup.ts; a site admin sets the band's policy.
  const canInviteWithSignup =
    band.memberSignup === 'owner' ? isOwner
    : band.memberSignup === 'editors' ? isOwner || band.memberRoles[user?.id ?? ''] === 'editor'
    : false;
  const inviteDaysNumber = Number(inviteDays);
  const inviteDaysValid = Number.isInteger(inviteDaysNumber) && inviteDaysNumber >= 1 && inviteDaysNumber <= 365;

  const handleRemoveMember = async (memberId: string) => {
    setBusyMemberId(memberId);
    const error = await removeMember(band.id, memberId);
    setBusyMemberId(null);

    if (error) {
      toast.error(error);
      return;
    }

    toast.success('Member removed.');
  };

  const handleCreateInviteLink = async () => {
    if (!user?.id || !user.email) {
      toast.error('You need to be signed in to create invite links.');
      return;
    }

    setBusyInviteLink(true);
    try {
      const result = await dataClient.bands.createInviteLink(band.id, {
        expiresInDays: inviteDaysNumber,
        allowSignup: canInviteWithSignup && inviteAllowSignup,
      });

      setLastInviteLink(result.inviteUrl);
      setLastInviteLinkExpiresAt(result.expiresAt ?? null);
      setLastInviteAllowsSignup(result.allowSignup);
      if (await copyText(result.inviteUrl)) toast.success('Invite link copied to clipboard.');
      else toast.success('Invite link created. Copy it from the field below.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create invite link.';
      toast.error(message);
    } finally {
      setBusyInviteLink(false);
    }
  };

  const handleCopyInviteLink = async () => {
    if (!lastInviteLink) return;
    if (await copyText(lastInviteLink)) toast.success('Invite link copied to clipboard.');
    else toast.error('Could not copy the link. Select and copy it manually.');
  };

  const handleShareInviteLink = async () => {
    if (!lastInviteLink) return;
    try {
      await navigator.share({
        title: `Join ${band.name} on Gigboy`,
        text: `You're invited to join ${band.name} on Gigboy.`,
        url: lastInviteLink,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      toast.error('Could not open sharing options.');
    }
  };

  const handleLeaveBand = async () => {
    if (!onLeaveCurrentUser) return;

    setBusyMemberId(user?.id ?? 'self');
    const error = await onLeaveCurrentUser();
    setBusyMemberId(null);

    if (error) {
      toast.error(error);
      return;
    }

    toast.success('You left the band.');
    onLeaveSuccess?.();
  };

  return (
    <section className="bands-panel">
      <h3>Band management</h3>
      <div className="bands-invite-form">
        <p className="bands-invite-intro">
          Invite bandmates with a link. One link works for everyone you share it with.
        </p>
        {canEditBand ? (
          <div className="bands-invite-options" role="group" aria-label="Invite link options">
            <label className="share-menu-field bands-invite-option">
              <div className="bands-invite-days">
                <span className="bands-invite-option-title">Link expires after</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={365}
                  step={1}
                  value={inviteDays}
                  onChange={(e) => setInviteDays(e.target.value)}
                  disabled={busyInviteLink}
                  aria-invalid={!inviteDaysValid}
                  aria-describedby={inviteDaysValid ? undefined : 'band-invite-days-error'}
                />
                <span>{inviteDaysNumber === 1 ? 'day' : 'days'}</span>
              </div>
              {!inviteDaysValid ? (
                <span id="band-invite-days-error" className="bands-invite-error">Enter a whole number of days from 1 to 365.</span>
              ) : null}
            </label>
            {canInviteWithSignup ? (
              <label className="bands-invite-signup bands-invite-option">
                <input
                  type="checkbox"
                  checked={inviteAllowSignup}
                  onChange={(e) => setInviteAllowSignup(e.target.checked)}
                  disabled={busyInviteLink}
                />
                <span>
                  <span className="bands-invite-option-title">Allow new accounts</span>
                  <small>People without a Gigboy account can create one from this link and join right away.</small>
                </span>
              </label>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          className="btn btn--primary"
          disabled={!canEditBand || busyInviteLink || !inviteDaysValid}
          onClick={() => { void handleCreateInviteLink(); }}
        >
          <UserPlus size={15} /> {busyInviteLink ? 'Creating link...' : 'Create invite link'}
        </button>
      </div>
      {lastInviteLink ? (
        <label className="share-menu-field" style={{ marginTop: '0.75rem' }}>
          <span>
            Invite link (share with as many bandmates as you like
            {lastInviteAllowsSignup ? '; anyone with it can create an account on this server' : ''})
          </span>
          <div className="share-menu-input-wrap">
            <input type="text" value={lastInviteLink} readOnly />
            <button
              type="button"
              className="share-menu-input-action"
              onClick={() => void handleCopyInviteLink()}
              title="Copy invite link"
              aria-label="Copy invite link"
            >
              <Copy size={15} />
            </button>
            <button
              type="button"
              className="share-menu-input-action"
              onClick={() => setShowInviteQr(true)}
              title="Show QR code"
              aria-label="Show invite link as QR code"
            >
              <QrCode size={15} />
            </button>
            {canNativeShare ? (
              <button
                type="button"
                className="share-menu-input-action"
                onClick={() => void handleShareInviteLink()}
                title="Share invite link"
                aria-label="Share invite link"
              >
                <Share2 size={15} />
              </button>
            ) : null}
          </div>
          {lastInviteLinkExpiresAt ? (
            <span style={{ fontSize: '0.8em', color: 'var(--color-text-muted, #888)', marginTop: '0.25rem' }}>
              Expires {new Date(lastInviteLinkExpiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
            </span>
          ) : null}
        </label>
      ) : null}
      {showInviteQr && lastInviteLink ? (
        <InviteQrModal url={lastInviteLink} title={`Join ${band.name}`} onClose={() => setShowInviteQr(false)} />
      ) : null}

      <h3 style={{ marginTop: '1rem' }}>Members</h3>
      <ul className="bands-members-list">
        {band.memberIds.map((memberId) => {
          const roleLabel = band.ownerId === memberId ? 'owner' : 'member';
          const username = band.memberUsernames[memberId] ?? null;
          const email = band.memberEmails[memberId] ?? 'No email saved';
          const fullName = band.memberFullNames[memberId] ?? null;
          const canRemove = isOwner && memberId !== band.ownerId;
          const inviterId = band.memberInvitedBy?.[memberId];
          const inviterName = inviterId
            ? band.memberFullNames[inviterId] ?? band.memberUsernames[inviterId] ?? null
            : null;
          const isCurrentUser = memberId === user?.id;

          return (
            <li key={memberId} className="bands-member-card">
              <UserAvatar label={fullName || username || email} size="md" />
              <div className="bands-member-copy">
                <strong>{username ?? email}</strong>
                <span>{username ? email : ''}</span>
                <span>{roleLabel}</span>
                {inviterName ? <span>Invited by {inviterName}</span> : null}
              </div>
              <div className="bands-member-actions">
                {canRemove ? (
                  <button
                    type="button"
                    className="btn btn--secondary"
                    disabled={busyMemberId === memberId}
                    onClick={() => void handleRemoveMember(memberId)}
                  >
                    {busyMemberId === memberId ? 'Working...' : 'Remove'}
                  </button>
                ) : null}
                {showLeaveCurrentUser && !isOwner && isCurrentUser ? (
                  <button
                    type="button"
                    className="btn btn--secondary"
                    disabled={busyMemberId === memberId}
                    onClick={() => { void handleLeaveBand(); }}
                  >
                    {busyMemberId === memberId ? 'Working...' : 'Leave band'}
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}