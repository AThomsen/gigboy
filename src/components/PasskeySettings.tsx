import { useEffect, useState } from 'react';
import { KeyRound, Pencil, Trash2 } from 'lucide-react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import toast from '../utils/anchoredToast';
import { dataClient } from '../lib/dataClient';
import type { Passkey } from '../lib/dataClient/types';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Profile section listing the user's passkeys, with add, rename and remove. */
export default function PasskeySettings() {
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const supported = browserSupportsWebAuthn();

  useEffect(() => {
    let cancelled = false;
    dataClient.auth
      .listPasskeys()
      .then((list) => {
        if (!cancelled) setPasskeys(list);
      })
      .catch(() => {
        if (!cancelled) setPasskeys([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleAdd() {
    setBusy(true);
    const { passkey, error } = await dataClient.auth.addPasskey();
    setBusy(false);
    if (error) toast.error(error);
    if (passkey) {
      setPasskeys((list) => [...(list ?? []), passkey]);
      toast.success('Passkey added.');
    }
  }

  async function handleRename(id: string) {
    const name = editingName.trim();
    if (!name) return;
    try {
      await dataClient.auth.renamePasskey(id, name);
      setPasskeys((list) => list?.map((p) => (p.id === id ? { ...p, name } : p)) ?? null);
      setEditingId(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to rename passkey.');
    }
  }

  async function handleRemove(passkey: Passkey) {
    if (!window.confirm(`Remove "${passkey.name}"? You won't be able to sign in with it any more.`)) return;
    try {
      await dataClient.auth.deletePasskey(passkey.id);
      setPasskeys((list) => list?.filter((p) => p.id !== passkey.id) ?? null);
      toast.success('Passkey removed.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove passkey.');
    }
  }

  return (
    <section className="profile-settings-card">
      <div className="profile-section-heading">
        <div>
          <h2><KeyRound size={18} aria-hidden="true" /> Passkeys</h2>
          <p className="profile-settings-muted">
            Sign in with your fingerprint, face or screen lock instead of a password. Add one on
            each device you use — passkeys saved to iCloud Keychain or Google Password Manager
            follow you to your other devices.
          </p>
        </div>
      </div>

      {passkeys === null ? (
        <p className="profile-settings-muted">Loading…</p>
      ) : passkeys.length === 0 ? (
        <p className="profile-settings-muted">No passkeys yet.</p>
      ) : (
        <ul className="passkey-list">
          {passkeys.map((passkey) => (
            <li key={passkey.id} className="passkey-item">
              {editingId === passkey.id ? (
                <form
                  className="passkey-rename"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleRename(passkey.id);
                  }}
                >
                  <input
                    type="text"
                    value={editingName}
                    maxLength={60}
                    aria-label="Passkey name"
                    autoFocus
                    onChange={(e) => setEditingName(e.target.value)}
                  />
                  <button type="submit" className="btn btn--primary btn--sm">Save</button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditingId(null)}>Cancel</button>
                </form>
              ) : (
                <>
                  <div className="passkey-info">
                    <strong>{passkey.name}</strong>
                    <span className="profile-settings-muted">
                      Added {formatDate(passkey.createdAt)}
                      {passkey.lastUsedAt ? ` · last used ${formatDate(passkey.lastUsedAt)}` : ''}
                    </span>
                  </div>
                  <div className="passkey-actions">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm btn--icon"
                      aria-label={`Rename ${passkey.name}`}
                      onClick={() => {
                        setEditingId(passkey.id);
                        setEditingName(passkey.name);
                      }}
                    >
                      <Pencil size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm btn--icon"
                      aria-label={`Remove ${passkey.name}`}
                      onClick={() => void handleRemove(passkey)}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {supported ? (
        <button type="button" className="btn btn--secondary" onClick={() => void handleAdd()} disabled={busy}>
          <KeyRound size={16} aria-hidden="true" /> {busy ? 'Waiting for passkey…' : 'Add a passkey on this device'}
        </button>
      ) : (
        <p className="profile-settings-muted">This browser can&rsquo;t create passkeys.</p>
      )}
    </section>
  );
}
