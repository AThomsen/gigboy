import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  collectStems,
  knownStemSuffix,
  mimeForAudioFile,
  stemColor,
  stemLengthsDiffer,
  stemNamesForFiles,
  stemSortOrder,
} from './stemImport';

describe('stemNamesForFiles', () => {
  it('takes the stem name from StemDeck file names', () => {
    expect(stemNamesForFiles([
      'Cadillac_Ranch_vocals.mp3',
      'Cadillac_Ranch_drums.mp3',
      'Cadillac_Ranch_bass.mp3',
      'Cadillac_Ranch_click.mp3',
    ])).toEqual(['vocals', 'drums', 'bass', 'click']);
  });

  it('accepts bare names and other separators', () => {
    expect(stemNamesForFiles(['vocals.wav', 'Drums.WAV', 'My Song - Bass.flac'])).toEqual(['vocals', 'drums', 'bass']);
  });

  it('matches lead_vocals and backing_vocals before vocals', () => {
    expect(knownStemSuffix('song_lead_vocals')).toBe('lead_vocals');
    expect(knownStemSuffix('song_backing_vocals')).toBe('backing_vocals');
    expect(knownStemSuffix('song_vocals')).toBe('vocals');
    expect(knownStemSuffix('song_vocalsx')).toBeNull();
  });

  it('strips the shared song prefix from unknown stems and de-duplicates names', () => {
    expect(stemNamesForFiles(['Song_X_synth.mp3', 'Song_X_vocals.mp3', 'Song_X_brass_section.mp3']))
      .toEqual(['synth', 'vocals', 'brass_section']);
    expect(stemNamesForFiles(['a/vocals.mp3', 'b/vocals.mp3'])).toEqual(['vocals', 'vocals_2']);
  });
});

describe('stem order, colour and type', () => {
  it('orders known stems first, unknown ones before click/original/mix', () => {
    const names = ['mix', 'click', 'synth', 'drums', 'vocals'];
    expect([...names].sort((a, b) => stemSortOrder(a) - stemSortOrder(b))).toEqual(['vocals', 'drums', 'synth', 'click', 'mix']);
  });

  it('gives known stems fixed colours and unknown ones a stable colour', () => {
    expect(stemColor('drums')).toMatch(/^#[0-9a-f]{6}$/);
    expect(stemColor('synth')).toBe(stemColor('synth'));
  });

  it('derives the MIME type from the extension and rejects non-audio', () => {
    expect(mimeForAudioFile('x.mp3')).toBe('audio/mpeg');
    expect(mimeForAudioFile('x.WAV')).toBe('audio/wav');
    expect(mimeForAudioFile('x.m4a')).toBeNull(); // the player can't decode AAC
    expect(mimeForAudioFile('project.rpp')).toBeNull();
    expect(mimeForAudioFile('beats.json')).toBeNull();
  });

  it('flags stems whose lengths differ by more than 10 ms', () => {
    expect(stemLengthsDiffer([183093, 183093, 183100])).toBe(false);
    expect(stemLengthsDiffer([183093, 183400])).toBe(true);
    expect(stemLengthsDiffer([183093, 0])).toBe(false);
  });
});

function readText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe('collectStems', () => {
  it('opens a StemDeck ZIP, skips non-audio files and types the stems', async () => {
    const zip = new JSZip();
    zip.file('Song_drums.mp3', 'drums');
    zip.file('Song_vocals.mp3', 'vocals');
    zip.file('Song.rpp', 'reaper');
    zip.file('beats.json', '{}');
    zip.file('__MACOSX/._Song_drums.mp3', 'junk');
    const data = await zip.generateAsync({ type: 'uint8array' });
    const stems = await collectStems([new File([data as BlobPart], 'Song_stems.zip', { type: 'application/zip' })]);

    expect(stems.map((s) => s.name)).toEqual(['vocals', 'drums']);
    const file = await stems[1].getFile();
    expect(file.name).toBe('Song_drums.mp3');
    expect(file.type).toBe('audio/mpeg');
    expect(await readText(file)).toBe('drums');
  });

  it('takes loose audio files and fixes their MIME type from the extension', async () => {
    const stems = await collectStems([
      new File(['b'], 'bass.wav', { type: 'audio/x-wav' }),
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
    ]);
    expect(stems).toHaveLength(1);
    expect((await stems[0].getFile()).type).toBe('audio/wav');
  });
});
