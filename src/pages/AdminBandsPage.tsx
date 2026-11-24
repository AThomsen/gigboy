import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from '../utils/anchoredToast';
import { dataClient } from '../lib/dataClient';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import type { AdminBandListing, MemberSignupPolicy } from '../lib/dataClient/types';

const SIGNUP_OPTIONS: { value: MemberSignupPolicy; label: string }[] = [
  { value: 'none', label: 'No' },
  { value: 'owner', label: 'Owner' },
  { value: 'editors', label: 'Editors' },
];

/**
 * Admin-only list of every band on the server, where an admin decides per band who may create
 * invite links that let newcomers create an account. Mirrors `server/routes/adminBands.ts`.
 */
export default function AdminBandsPage() {
  useDocumentTitle('Bands (admin)');

  const [bands, setBands] = useState<AdminBandListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    dataClient.adminBands
      .list()
      .then((list) => {
        if (!cancelled) setBands(list);
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : 'Failed to load bands.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChange = async (band: AdminBandListing, memberSignup: MemberSignupPolicy) => {
    setBusyId(band.id);
    try {
      await dataClient.adminBands.setMemberSignup(band.id, memberSignup);
      setBands((prev) => prev.map((b) => (b.id === band.id ? { ...b, memberSignup } : b)));
      toast.success(`Updated sign-up for ${band.name}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update band.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="profile-invites-page">
      <header className="profile-invites-header">
        <h1>Bands</h1>
        <p>
          Every band on this instance. <strong>Allow new member sign-up</strong> decides who in a band may
          create invite links that let people without an account create one and join: nobody, the band&rsquo;s
          owner, or its owner and editors. Tightening it also stops sign-up through links already shared.
        </p>
      </header>

      <nav className="admin-tabs">
        <Link to="/admin/invites">Invites</Link>
        <Link to="/admin/users">Users</Link>
        <Link to="/admin/bands" className="active" aria-current="page">Bands</Link>
      </nav>

      <section className="profile-invites-section">
        <h2>All bands</h2>
        {loading ? (
          <p className="profile-invites-status">Loading bands…</p>
        ) : bands.length === 0 ? (
          <p className="profile-invites-status">No bands yet.</p>
        ) : (
          <ul className="profile-invites-list">
            {bands.map((band) => (
              <li key={band.id} className="profile-invite-card">
                <div className="profile-invite-main">
                  <strong>{band.name}</strong>
                  <span>
                    Owned by {band.ownerName} · {band.memberCount} {band.memberCount === 1 ? 'member' : 'members'}
                  </span>
                </div>
                <div className="profile-invite-actions">
                  <label className="admin-band-signup">
                    Allow new member sign-up
                    <select
                      value={band.memberSignup}
                      onChange={(e) => void handleChange(band, e.target.value as MemberSignupPolicy)}
                      disabled={busyId === band.id}
                    >
                      {SIGNUP_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
