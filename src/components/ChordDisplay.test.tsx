import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ChordDisplay from './ChordDisplay';

const SONG = [
  '{start_of_verse}',
  '[C]Hello [G]world',
  'No chords on this line',
  '{end_of_verse}',
  '[Am] [F]',
  '{start_of_tab}',
  'e|--0--|',
  '{end_of_tab}',
].join('\n');

const lyrics = (el: HTMLElement) => Array.from(el.querySelectorAll('.lyric-text')).map((n) => n.textContent).join('|');
const chords = (el: HTMLElement) => Array.from(el.querySelectorAll('.chord-name')).map((n) => n.textContent?.trim()).join(' ');

describe('ChordDisplay lyrics / chords visibility', () => {
  afterEach(cleanup);

  it('shows lyrics and chords by default', () => {
    const { container } = render(<ChordDisplay chordpro={SONG} />);
    expect(lyrics(container)).toContain('No chords on this line');
    expect(chords(container)).toContain('C');
    expect(container.querySelector('.tab-block, .tab-content')).toBeTruthy();
  });

  it('hides chords, chords-only lines and tabs for lyrics only', () => {
    const { container } = render(<ChordDisplay chordpro={SONG} showChords={false} />);
    expect(container.querySelector('.chord-display--lyrics-only')).toBeTruthy();
    expect(container.querySelector('.chord-name')).toBeNull();
    expect(container.querySelector('.tab-content')).toBeNull();
    expect(lyrics(container)).toContain('Hello');
    expect(lyrics(container)).toContain('No chords on this line');
    // The [Am] [F] line has no lyrics, so nothing of it is left.
    expect(container.querySelectorAll('.chord-line:not(.chord-line--empty)')).toHaveLength(2);
    expect(container.querySelector('.section-label')?.textContent).toBe('Verse');
  });

  it('lists just the chords for chords only, leaving out lyric-only lines', () => {
    const { container } = render(<ChordDisplay chordpro={SONG} showLyrics={false} />);
    expect(container.querySelector('.chord-display--chords-only')).toBeTruthy();
    expect(container.querySelector('.lyric-text')).toBeNull();
    expect(chords(container)).toBe('C G Am F');
    expect(container.querySelectorAll('.chord-line--chord-only')).toHaveLength(2);
    expect(container.querySelector('.tab-content')).toBeTruthy();
    expect(container.querySelector('.section-label')?.textContent).toBe('Verse');
  });

  it('falls back to lyrics when both are hidden', () => {
    const { container } = render(<ChordDisplay chordpro={SONG} showChords={false} showLyrics={false} />);
    expect(lyrics(container)).toContain('Hello');
  });
});
