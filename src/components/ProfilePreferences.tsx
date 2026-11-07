import { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import toast from '../utils/anchoredToast';
import { useAuth } from '../context/AuthContext';
import {
  DEFAULT_DOWNBEAT_COLOR,
  DOWNBEAT_COLOR_OPTIONS,
  type DownbeatColor,
  type UserPreferences,
} from '../lib/userPreferences';

/**
 * Profile-page card for per-user app preferences. Saved to the account (not the device),
 * and applied as soon as an option is picked. Group new options by the area they affect.
 */
export default function ProfilePreferences() {
  const { user, updatePreferences } = useAuth();
  const [saving, setSaving] = useState(false);
  const prefs: UserPreferences = user?.preferences ?? {};
  const downbeatColor = prefs.concertDownbeatColor ?? DEFAULT_DOWNBEAT_COLOR;

  const save = async (update: UserPreferences) => {
    setSaving(true);
    const error = await updatePreferences(update);
    setSaving(false);
    if (error) toast.error(error);
  };

  return (
    <section className="profile-settings-card">
      <div className="profile-section-heading">
        <div>
          <h2><SlidersHorizontal size={18} aria-hidden="true" /> Preferences</h2>
        </div>
      </div>

      <div className="profile-pref-group">
        <h3>Concert mode</h3>
        <div className="profile-pref-row">
          <div className="profile-pref-label" id="pref-downbeat-label">
            Beat one colour
            <span className="profile-settings-muted">Colour of the first beat of each bar in the beat flash.</span>
          </div>
          <div className="profile-pref-swatches" role="radiogroup" aria-labelledby="pref-downbeat-label">
            {DOWNBEAT_COLOR_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={downbeatColor === option.value}
                aria-label={option.label}
                title={option.label}
                disabled={saving}
                className={`profile-pref-swatch${downbeatColor === option.value ? ' is-selected' : ''}`}
                style={{ '--swatch-color': option.css } as React.CSSProperties}
                onClick={() => {
                  if (option.value !== downbeatColor) {
                    void save({ concertDownbeatColor: option.value as DownbeatColor });
                  }
                }}
              />
            ))}
            <span className="profile-pref-current" aria-hidden="true">
              {DOWNBEAT_COLOR_OPTIONS.find((o) => o.value === downbeatColor)?.label}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
