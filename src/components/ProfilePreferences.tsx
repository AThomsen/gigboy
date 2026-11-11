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
  const tapToNavigate = prefs.concertTapToNavigate !== false;
  const showNavButtons = prefs.concertShowNavButtons !== false;

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
        <div className="profile-pref-row">
          <div className="profile-pref-label" id="pref-tap-label">
            Tap to turn pages
            <span className="profile-settings-muted">
              Tap the chart to turn pages (left half back, right half forward), or when scrolling, to scroll (upper half up, lower half down). Turn off if stray taps get in your way; swipes, keys and the buttons still work.
            </span>
          </div>
          <label className="toggle-label">
            <input
              type="checkbox"
              checked={tapToNavigate}
              disabled={saving}
              aria-labelledby="pref-tap-label"
              onChange={(e) => { void save({ concertTapToNavigate: e.target.checked }); }}
            />
            {tapToNavigate ? 'On' : 'Off'}
          </label>
        </div>
        <div className="profile-pref-row">
          <div className="profile-pref-label" id="pref-nav-buttons-label">
            Previous / Next buttons
            <span className="profile-settings-muted">
              Show the Previous and Next buttons at the bottom of the screen. Turn off for more room if you turn pages by tapping, swiping or with a pedal.
            </span>
          </div>
          <label className="toggle-label">
            <input
              type="checkbox"
              checked={showNavButtons}
              disabled={saving}
              aria-labelledby="pref-nav-buttons-label"
              onChange={(e) => { void save({ concertShowNavButtons: e.target.checked }); }}
            />
            {showNavButtons ? 'On' : 'Off'}
          </label>
        </div>
      </div>
    </section>
  );
}
