import { useState } from 'react';
import { Crown } from 'lucide-react';
import toast from '../utils/anchoredToast';
import { dataClient } from '../lib/dataClient';
import type { Band } from '../types';

interface TransferOwnershipPanelProps {
  band: Band;
  /** True when the current user owns the band (they keep membership as an editor afterwards). */
  isOwner: boolean;
  /** Called after the server accepted the transfer, with the updated band. */
  onTransferred: (band: Band) => void | Promise<void>;
}

function memberLabel(band: Band, memberId: string): string {
  const name = band.memberFullNames[memberId] ?? band.memberUsernames[memberId] ?? band.memberEmails[memberId] ?? 'Unknown member';
  const email = band.memberEmails[memberId];
  return email && email !== name ? `${name} (${email})` : name;
}

/** Hands the band to another member. Shown to the band's owner and to site admins. */
export default function TransferOwnershipPanel({ band, isOwner, onTransferred }: TransferOwnershipPanelProps) {
  const candidates = band.memberIds.filter((id) => id !== band.ownerId);
  const [newOwnerId, setNewOwnerId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const newOwnerName = newOwnerId ? memberLabel(band, newOwnerId) : '';

  const handleTransfer = async () => {
    setBusy(true);
    try {
      const updated = await dataClient.bands.transferOwnership(band.id, newOwnerId);
      toast.success(`${newOwnerName} now owns ${band.name}.`);
      setConfirming(false);
      setNewOwnerId('');
      await onTransferred(updated);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to transfer ownership.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bands-panel">
      <h3>Transfer ownership</h3>
      <p className="bands-invite-intro">
        {isOwner
          ? "Make another member the band's owner. You stay in the band as an editor, but lose access to these settings."
          : `Currently owned by ${memberLabel(band, band.ownerId)}. As an admin you can hand the band to another member.`}
      </p>
      {candidates.length === 0 ? (
        <p className="bands-invite-intro">Invite someone to the band first — only members can become owner.</p>
      ) : confirming ? (
        <div className="bands-transfer-confirm">
          <p>
            Make <strong>{newOwnerName}</strong> the owner of <strong>{band.name}</strong>?
            {band.memberRoles[newOwnerId] === 'viewer' ? ' They will also become an editor.' : ''}
          </p>
          <div className="bands-delete-confirm-actions">
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void handleTransfer()}>
              {busy ? 'Transferring…' : 'Transfer ownership'}
            </button>
            <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="bands-transfer-form">
          <label className="share-menu-field">
            <span>New owner</span>
            <select value={newOwnerId} onChange={(e) => setNewOwnerId(e.target.value)}>
              <option value="">Choose a member…</option>
              {candidates.map((id) => (
                <option key={id} value={id}>{memberLabel(band, id)}</option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn--secondary" disabled={!newOwnerId} onClick={() => setConfirming(true)}>
            <Crown size={15} /> Transfer ownership…
          </button>
        </div>
      )}
    </section>
  );
}
