/**
 * Per-user app preferences, saved on the account so they follow the user across devices.
 * The server validates the same keys (server/lib/userPreferences.ts).
 */
export type DownbeatColor = 'amber' | 'red' | 'green' | 'blue' | 'purple' | 'accent';

export interface UserPreferences {
  /** Colour of beat one in the concert-mode beat flash. 'accent' = same as the other beats. */
  concertDownbeatColor?: DownbeatColor;
  /** Whether tapping the chart turns pages in concert mode's page mode. Default on. */
  concertTapToNavigate?: boolean;
}

export const DEFAULT_DOWNBEAT_COLOR: DownbeatColor = 'amber';

export const DOWNBEAT_COLOR_OPTIONS: { value: DownbeatColor; label: string; css: string }[] = [
  { value: 'amber', label: 'Amber', css: '#f5a524' },
  { value: 'red', label: 'Red', css: '#ef4444' },
  { value: 'green', label: 'Green', css: '#22c55e' },
  { value: 'blue', label: 'Blue', css: '#3b82f6' },
  { value: 'purple', label: 'Purple', css: '#a855f7' },
  { value: 'accent', label: 'Same as other beats', css: 'var(--accent)' },
];

export function downbeatColorCss(color: DownbeatColor | undefined): string {
  const option = DOWNBEAT_COLOR_OPTIONS.find((o) => o.value === (color ?? DEFAULT_DOWNBEAT_COLOR));
  return option?.css ?? DOWNBEAT_COLOR_OPTIONS[0].css;
}
