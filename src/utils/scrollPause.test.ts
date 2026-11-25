import { describe, it, expect } from 'vitest';
import { parsePause, pauseSeconds, beatsPerBar, describePause } from './scrollPause';
import { parseChordPro } from './chordParser';

describe('parsePause', () => {
  it('reads bars, with or without the unit', () => {
    expect(parsePause('16 bars')).toEqual({ bars: 16 });
    expect(parsePause('16')).toEqual({ bars: 16 });
    expect(parsePause('1 bar')).toEqual({ bars: 1 });
  });

  it('reads seconds', () => {
    expect(parsePause('20s')).toEqual({ seconds: 20 });
    expect(parsePause('20 sec')).toEqual({ seconds: 20 });
    expect(parsePause('7.5 seconds')).toEqual({ seconds: 7.5 });
  });

  it('takes a label after a comma', () => {
    expect(parsePause('16 bars, Guitar solo')).toEqual({ bars: 16, label: 'Guitar solo' });
  });

  it('treats a bare pause or plain words as untimed', () => {
    expect(parsePause(undefined)).toEqual({});
    expect(parsePause('')).toEqual({});
    expect(parsePause('Drum break')).toEqual({ label: 'Drum break' });
  });
});

describe('pauseSeconds', () => {
  it('converts bars with the tempo and time signature', () => {
    expect(pauseSeconds({ bars: 8 }, 120, '4/4')).toBe(16);
    expect(pauseSeconds({ bars: 8 }, 120, undefined)).toBe(16);
    expect(pauseSeconds({ bars: 4 }, 90, '3/4')).toBe(8);
    expect(pauseSeconds({ bars: 2 }, 120, '6/8')).toBe(6);
  });

  it('uses seconds as they are', () => {
    expect(pauseSeconds({ seconds: 20 }, undefined, undefined)).toBe(20);
  });

  it('waits for a tap without a tempo, or without an amount', () => {
    expect(pauseSeconds({ bars: 16 }, undefined, '4/4')).toBeNull();
    expect(pauseSeconds({}, 120, '4/4')).toBeNull();
  });
});

describe('beatsPerBar', () => {
  it('falls back to 4', () => {
    expect(beatsPerBar('7/8')).toBe(7);
    expect(beatsPerBar('nonsense')).toBe(4);
  });
});

describe('describePause', () => {
  it('labels the marker', () => {
    expect(describePause({ bars: 16, label: 'Guitar solo' })).toBe('Guitar solo · 16 bars');
    expect(describePause({ seconds: 20 })).toBe('Hold · 20 s');
    expect(describePause({})).toBe('Hold');
  });
});

describe('parseChordPro with scroll holds', () => {
  it('parses {hold} and {hold: …} as directives', () => {
    const lines = parseChordPro('{hold}\n{hold: 16 bars, Solo}');
    expect(lines.map((l) => [l.type, l.directive, l.directiveValue])).toEqual([
      ['directive', 'hold', undefined],
      ['directive', 'hold', '16 bars, Solo'],
    ]);
  });
});
