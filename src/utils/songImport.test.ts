import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { expandSongImportSelection, parseImportedSongFile, parseImportedSongText } from './songImport';

// jsdom's File doesn't implement text()/arrayBuffer(), so build minimal stand-ins that
// satisfy the parts of the File interface songImport actually touches.
function textFile(name: string, content: string, type = 'text/plain'): File {
  return {
    name,
    type,
    text: () => Promise.resolve(content),
  } as unknown as File;
}

function zipFile(name: string, buffer: ArrayBuffer): File {
  return {
    name,
    type: 'application/zip',
    arrayBuffer: () => Promise.resolve(buffer),
  } as unknown as File;
}

describe('parseImportedSongText', () => {
  it('derives a title from the file name when the content has none', () => {
    const draft = parseImportedSongText('songs/Wagon Wheel.cho', '[G]Rock me [D]mama');
    expect(draft.title).toBe('Wagon Wheel');
    expect(draft.chordpro).toContain('[G]Rock me [D]mama');
  });

  it('reads YAML frontmatter', () => {
    const draft = parseImportedSongText('x.chordpro', '---\ntitle: Test Song\nartist: Someone\n---\n[C]hi');
    expect(draft.title).toBe('Test Song');
    expect(draft.artist).toBe('Someone');
    expect(draft.detectedSource).toBe('Frontmatter');
  });
});

// Same shape as the file Ultimate Guitar's iOS app shares (named `lyrics_tmp`, no extension):
// only the body, as section headers and chord rows above lyric lines. The song is "Amazing
// Grace" (John Newton, 1779), which is in the public domain.
const UG_SHARE_FILE = [
  '[Intro]',
  'G C G D',
  '',
  '',
  '[Verse 1]',
  'G              C             G',
  'Amazing grace, how sweet the sound',
  'G            D',
  'That saved a wretch like me',
  '',
  '[Verse 2]',
  'Em7              D7sus4',
  "'Twas grace that taught my heart to fear",
].join('\n');

describe('Ultimate Guitar share file (lyrics_tmp)', () => {
  it('imports the body, leaving the title for the user', async () => {
    const draft = await parseImportedSongFile(textFile('lyrics_tmp', UG_SHARE_FILE, ''));
    expect(draft.title).toBe('');
    expect(draft.detectedSource).toBe('Ultimate Guitar');
    expect(draft.chordpro).toContain('{comment: Intro}\n[G] [C] [G] [D]');
    expect(draft.chordpro).toContain(
      '{start_of_verse: Verse 1}\n[G]Amazing grace, [C]how sweet the [G]sound\n[G]That saved a [D]wretch like me',
    );
    expect(draft.chordpro).toContain("{start_of_verse: Verse 2}\n[Em7]'Twas grace that [D7sus4]taught my heart to fear");
  });

  it('gets a placeholder title in bulk import, which saves without review', async () => {
    const result = await expandSongImportSelection([textFile('lyrics_tmp', UG_SHARE_FILE, '')]);
    expect(result.errors).toHaveLength(0);
    expect(result.items[0].draft.title).toBe('Untitled song');
  });

  it('still rejects an extensionless file that is not text', async () => {
    await expect(parseImportedSongFile(textFile('blob', 'PK\u0003\u0004\u0000\u0000binary', ''))).rejects.toThrow(/Only text song files/);
  });

  it('keeps rejecting unsupported extensions', async () => {
    await expect(parseImportedSongFile(textFile('photo.jpg', 'x', 'image/jpeg'))).rejects.toThrow(/Only text song files/);
  });
});

describe('expandSongImportSelection', () => {
  it('parses loose song files and collects per-file errors', async () => {
    const result = await expandSongImportSelection([
      textFile('One.cho', '[G]one'),
      textFile('Two.txt', '[C]two'),
      textFile('empty.cho', '   '),
    ]);

    expect(result.items.map((i) => i.draft.title).sort()).toEqual(['One', 'Two']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].name).toBe('empty.cho');
  });

  it('flattens a .zip archive of song files', async () => {
    const zip = new JSZip();
    zip.file('backup/Song A.cho', '[G]a');
    zip.file('backup/Song B.onsong', 'Song B\nArtist Name\n[C]b');
    zip.file('backup/notes.pdf', 'not a song');
    const buffer = await zip.generateAsync({ type: 'arraybuffer' });

    const result = await expandSongImportSelection([zipFile('my-backup.zip', buffer)]);

    expect(result.errors).toHaveLength(0);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((i) => i.draft.title).sort()).toEqual(['Song A', 'Song B']);
    expect(result.items.every((i) => i.name.startsWith('my-backup.zip › '))).toBe(true);
  });

  it('reports a zip with no recognisable song files', async () => {
    const zip = new JSZip();
    zip.file('readme.pdf', 'x');
    const buffer = await zip.generateAsync({ type: 'arraybuffer' });

    const result = await expandSongImportSelection([zipFile('empty.zip', buffer)]);
    expect(result.items).toHaveLength(0);
    expect(result.errors[0].message).toMatch(/no song files/i);
  });
});

describe('Songbook Pro backups', () => {
  async function sbpBackup(): Promise<File> {
    const data = {
      songs: [
        { Id: 1, name: 'Amazing Grace', author: 'John Newton', type: 1, key: 5, KeyShift: 10, Duration: 185, Capo: 0, TempoInt: 0, timeSig: '', Url: '', Deleted: false, content: '{c: Verse 1}\r\nAmazing[D] Grace, how s[G]weet the so[D]und' },
        { Id: 2, name: 'Sheet Music', author: '', type: 2, key: -1, KeyShift: 0, Deleted: false, content: 'abc.pdf' },
        { Id: 3, name: 'Gone', type: 1, Deleted: true, content: '[C]gone' },
        { Id: 4, name: 'Missing PDF', type: 2, Deleted: false, content: 'nope.pdf' },
      ],
      sets: [
        {
          details: { name: 'Friday', Deleted: 0 },
          contents: [
            { Order: 1, SongId: 2, ItemType: 1, keyOfset: 0, Deleted: 0 },
            { Order: 0, SongId: 1, ItemType: 1, keyOfset: 3, Deleted: 0 },
            { Order: 2, SongId: 3, ItemType: 1, keyOfset: 0, Deleted: 0 },
          ],
        },
      ],
      folders: [],
    };
    const zip = new JSZip();
    zip.file('dataFile.txt', `1.0\r\n${JSON.stringify(data)}`);
    zip.file('dataFile.hash', 'x');
    zip.file('pdf/abc.pdf', '%PDF-1.4');
    const buffer = await zip.generateAsync({ type: 'arraybuffer' });
    return { name: 'SongbookPro Backup.sbpbackup', type: '', arrayBuffer: () => Promise.resolve(buffer) } as unknown as File;
  }

  it('imports songs with their metadata, skipping deleted ones', async () => {
    const result = await expandSongImportSelection([await sbpBackup()]);

    expect(result.items.map((i) => i.draft.title)).toEqual(['Amazing Grace', 'Sheet Music']);
    const grace = result.items[0].draft;
    expect(grace.artist).toBe('John Newton');
    expect(grace.key).toBe('D');
    expect(grace.preferredTranspose).toBe(-2);
    expect(grace.durationSeconds).toBe(185);
    expect(grace.capo).toBeUndefined();
    expect(grace.chordpro).toContain('Amazing[D] Grace');
    expect(grace.chordpro).not.toContain('\r');
  });

  it('attaches the PDF of PDF songs and reports missing ones', async () => {
    const result = await expandSongImportSelection([await sbpBackup()]);

    const sheet = result.items[1];
    expect(sheet.draft.chordpro).toBe('');
    expect(sheet.attachments).toHaveLength(1);
    expect(sheet.attachments![0].name).toBe('Sheet Music.pdf');
    expect(sheet.attachments![0].type).toBe('application/pdf');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].name).toMatch(/Missing PDF/);
  });

  it('turns sets into setlists in set order, with transpose notes', async () => {
    const result = await expandSongImportSelection([await sbpBackup()]);

    expect(result.setlists).toHaveLength(1);
    const [friday] = result.setlists;
    expect(friday.name).toBe('Friday');
    const refs = friday.songs.map((song) => result.items.find((item) => item.ref === song.ref)?.draft.title);
    expect(refs).toEqual(['Amazing Grace', 'Sheet Music']);
    expect(friday.songs[0].note).toBe('Transpose +3');
    expect(friday.songs[1].note).toBeUndefined();
  });
});

describe('importing PDFs', () => {
  it('makes a song of each PDF, titled after the file, with the PDF to show as its chart', async () => {
    const pdf = { name: 'Autumn_Leaves-lead sheet.pdf', type: 'application/pdf' } as unknown as File;
    const result = await expandSongImportSelection([pdf]);
    expect(result.errors).toEqual([]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].draft.title).toBe('Autumn Leaves lead sheet');
    expect(result.items[0].draft.chordpro).toBe('');
    expect(result.items[0].attachments).toEqual([pdf]);
  });
});
