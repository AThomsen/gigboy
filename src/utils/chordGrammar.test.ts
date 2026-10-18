import { describe, expect, it } from 'vitest';
import { CHORD_TOKEN_RE, normalizeChordSymbols } from './chordGrammar';
import { parsePastedSong } from './chordFormatParser';

describe('chord grammar', () => {
  it.each([
    'G', 'Am7', 'Cmaj7', 'G7sus4', 'C#m7b5', 'A7(b9)', 'Gm7b5', 'Cadd9', 'C6/9', 'Cm(maj7)',
    'Bbmaj7#11', 'E5', 'F♯m', 'B♭', 'C+', 'C°', 'C△7', 'CM7', 'Dm7-5', 'C7#9', 'Bm7b5/E',
    'D/F#', 'Asus2', 'F#m7add11', 'D9sus4', 'N.C.', 'NC',
  ])('accepts %s', (c) => expect(CHORD_TOKEN_RE.test(c)).toBe(true));

  it.each(['Chorus', 'Bridge', 'Dance', 'Beautiful', 'repeat from the top', 'Am I', 'Hm', 'Gone'])(
    'rejects %s', (c) => expect(CHORD_TOKEN_RE.test(c)).toBe(false),
  );

  it('normalizes unicode symbols', () => {
    expect(normalizeChordSymbols('F♯m7♭5')).toBe('F#m7b5');
    expect(normalizeChordSymbols('C△7')).toBe('Cmaj7');
    expect(normalizeChordSymbols('Bø')).toBe('Bm7b5');
  });
});

describe('pasted chord-over-lyric placement with complex chords', () => {
  it('places extended chords over the right syllable', () => {
    const r = parsePastedSong('G7sus4   Bm7b5\nHello darling friend');
    expect(r.chordpro).toBe('[G7sus4]Hello dar[Bm7b5]ling friend');
  });
  it('does not swallow a following chord row or section label as lyrics', () => {
    const r = parsePastedSong('C7#9  F♯m\nAm7  D\nsome lyric');
    expect(r.chordpro).toBe('[C7#9] [F#m]\n[Am7]some [D]lyric');
    const r2 = parsePastedSong('Am7  D\n[Chorus]\nsome lyric');
    expect(r2.chordpro).toContain('[Am7] [D]\n{start_of_chorus: Chorus}');
  });
});
