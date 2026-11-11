/**
 * Per-user app preferences, stored as JSON on the user row. Each option is validated here;
 * unknown keys and invalid values are dropped so stored JSON stays clean. Mirrors
 * src/lib/userPreferences.ts on the client.
 */
export const DOWNBEAT_COLORS = ['amber', 'red', 'green', 'blue', 'purple', 'accent'] as const;
export type DownbeatColor = (typeof DOWNBEAT_COLORS)[number];

export interface UserPreferences {
  /** Colour of beat one in the concert-mode beat flash. 'accent' = same as the other beats. */
  concertDownbeatColor?: DownbeatColor;
  /** Whether tapping the chart turns pages in concert mode's page mode. Default on. */
  concertTapToNavigate?: boolean;
  /** Whether concert mode shows the Previous / Next buttons at the bottom. Default on. */
  concertShowNavButtons?: boolean;
}

export function sanitizeUserPreferences(input: unknown): UserPreferences {
  const prefs: UserPreferences = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return prefs;
  const raw = input as Record<string, unknown>;
  if (typeof raw.concertDownbeatColor === 'string'
    && (DOWNBEAT_COLORS as readonly string[]).includes(raw.concertDownbeatColor)) {
    prefs.concertDownbeatColor = raw.concertDownbeatColor as DownbeatColor;
  }
  if (typeof raw.concertTapToNavigate === 'boolean') prefs.concertTapToNavigate = raw.concertTapToNavigate;
  if (typeof raw.concertShowNavButtons === 'boolean') prefs.concertShowNavButtons = raw.concertShowNavButtons;
  return prefs;
}
