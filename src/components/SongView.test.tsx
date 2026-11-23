import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SongView from './SongView';
import type { Song } from '../types';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  location: { state: null as { backTo?: string; backLabel?: string; bandId?: string } | null },
  updateBandSong: vi.fn(),
  removeSongFromBandLibrary: vi.fn(),
  showConfirmToast: vi.fn(),
  showPromptToast: vi.fn(),
  toast: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  bands: [] as Array<{ id: string; memberRoles?: Record<string, string> }>,
  stems: [] as Array<{ id: string; name: string; downloadUrl: string; durationMs: number; sizeBytes: number; mimeType: string; sortOrder: number; createdAt: string; waveformBars?: number[] }>,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
    useLocation: () => mocks.location,
  };
});

vi.mock('../context/BandsContext', () => ({
  useBands: () => ({
    bands: mocks.bands,
    bandSongListsByBandId: {},
    bandSetlistsByBandId: {},
    updateBandSong: mocks.updateBandSong,
    addSongToBandSongList: vi.fn(),
    removeSongFromBandSongList: vi.fn(),
    addSongToBandSetlist: vi.fn(),
    removeSongFromBandSetlist: vi.fn(),
    removeSongFromBandLibrary: mocks.removeSongFromBandLibrary,
  }),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1' },
  }),
}));

vi.mock('../hooks/useSongHandNotes', () => ({
  useSongHandNotes: () => ({
    notes: [],
    myStrokes: [],
    visibleNotes: [],
    saveMyNotes: vi.fn(),
    clearMyNotes: vi.fn(),
    saveState: 'idle',
    authors: [],
    visibleAuthorIds: [],
    showAll: vi.fn(),
    showMineOnly: vi.fn(),
    toggleVisibleAuthor: vi.fn(),
    undoStroke: vi.fn(),
    redoStroke: vi.fn(),
    canUndo: false,
    canRedo: false,
  }),
}));

vi.mock('../hooks/useSongRecordings', () => ({
  useSongRecordings: () => ({
    recordings: [],
  }),
}));

vi.mock('../hooks/useSongStems', () => ({
  useSongStems: () => ({
    stems: mocks.stems,
    loading: false,
    progress: null,
    error: null,
    importStems: vi.fn(),
    deleteStem: vi.fn(),
    deleteAllStems: vi.fn(),
  }),
}));

// jsdom has no Web Audio; the card only needs a player that never finishes loading.
vi.mock('../lib/stemPlayer', async () => {
  const actual = await vi.importActual<typeof import('../lib/stemPlayer')>('../lib/stemPlayer');
  class FakeStemPlayer {
    duration = 0;
    isPlaying = false;
    position = 0;
    load() { return new Promise(() => {}); }
    setMix() {}
    setLoop() {}
    dispose() {}
  }
  return { ...actual, StemPlayer: FakeStemPlayer };
});

vi.mock('../hooks/useSongAttachments', () => ({
  useSongAttachments: () => ({
    attachments: [],
  }),
}));

vi.mock('../utils/toastDialogs', () => ({
  showConfirmToast: mocks.showConfirmToast,
  showPromptToast: mocks.showPromptToast,
}));

vi.mock('../utils/anchoredToast', () => {
  const toast = Object.assign(mocks.toast, {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  });
  return { default: toast };
});

vi.mock('../utils/songMedia', () => ({
  parseSongMedia: () => null,
}));

vi.mock('./ChordDisplay', () => ({
  default: () => <div data-testid="chord-display" />,
}));

vi.mock('./ChordDiagram', () => ({
  default: () => null,
}));

vi.mock('./LanguageBadge', () => ({
  default: () => <span>lang</span>,
}));

vi.mock('./VisualMetronome', () => ({
  default: () => <div />,
}));

vi.mock('./VisualTuner', () => ({
  default: () => <div />,
}));

vi.mock('./SongHandNotesOverlay', () => ({
  default: () => <div />,
}));

vi.mock('./SongMediaPlayer', () => ({
  default: () => <div />,
}));

vi.mock('./SongRecorder', () => ({
  default: () => <div />,
}));

const baseSong: Song = {
  id: 'song-1',
  title: 'My Song',
  language: 'en',
  chordpro: '[G]Hello',
};

describe('SongView actions', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.updateBandSong.mockReset();
    mocks.removeSongFromBandLibrary.mockReset();
    mocks.showConfirmToast.mockReset();
    mocks.showPromptToast.mockReset();
    mocks.toast.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
    mocks.location.state = null;
    mocks.bands = [];
    mocks.stems = [];
  });

  it('passes song page state to edit navigation', () => {
    const state = { backTo: '/bands/band-1/library', backLabel: 'Band library', bandId: 'band-1' };
    mocks.location.state = state;

    render(<SongView song={baseSong} bandId="band-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit My Song' }));

    expect(mocks.navigate).toHaveBeenCalledWith('/songs/song-1/edit', { state });
  });

  it('deletes from band library when viewed in band context', async () => {
    const state = { backTo: '/bands/band-1/library', backLabel: 'Band library', bandId: 'band-1' };
    mocks.location.state = state;
    mocks.showConfirmToast.mockResolvedValue(true);
    mocks.removeSongFromBandLibrary.mockResolvedValue(null);

    render(<SongView song={{ ...baseSong }} bandId="band-1" />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete My Song' })[0]);

    await waitFor(() => {
      expect(mocks.removeSongFromBandLibrary).toHaveBeenCalledWith('band-1', 'song-1');
    });
    expect(mocks.navigate).toHaveBeenCalledWith('/bands/band-1/library', { state });
  });

  it('renames band song through band updater', async () => {
    mocks.showPromptToast.mockResolvedValue('Renamed Song');
    mocks.updateBandSong.mockResolvedValue(null);

    render(<SongView song={{ ...baseSong }} bandId="band-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Rename My Song' }));

    await waitFor(() => {
      expect(mocks.updateBandSong).toHaveBeenCalledWith(
        'band-1',
        expect.objectContaining({ id: 'song-1', title: 'Renamed Song' })
      );
    });
  });

  describe('stems', () => {
    const stem = (id: string, name: string) => ({
      id, name, downloadUrl: `/api/x/${id}/download`, durationMs: 1000, sizeBytes: 10, mimeType: 'audio/mpeg', sortOrder: 0, createdAt: '2026-11-23T00:00:00Z', waveformBars: [0.5, 0.2],
    });

    it('shows a Stems tool that opens the stems card with an import button for editors', () => {
      render(<SongView song={baseSong} bandId="band-1" />);
      const button = screen.getByRole('button', { name: 'Show stems' });
      expect(button.className).not.toContain('song-toolbar-tool-btn--has-content');

      fireEvent.click(button);

      expect(screen.getByText(/No stems yet/)).toBeTruthy();
      expect(screen.getByRole('button', { name: /Import stems/ })).toBeTruthy();
    });

    it('marks the Stems tool when stems exist and lists a lane per stem', () => {
      mocks.stems = [stem('s1', 'vocals'), stem('s2', 'drums')];
      render(<SongView song={baseSong} bandId="band-1" />);
      const button = screen.getByRole('button', { name: 'Show stems' });
      expect(button.className).toContain('song-toolbar-tool-btn--has-content');

      fireEvent.click(button);

      expect(screen.getByRole('button', { name: 'Mute Vocals' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Solo Drums' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Remove Vocals stem' })).toBeTruthy();
      expect(screen.getByRole('button', { name: /Remove all/ })).toBeTruthy();
    });

    it('lets viewers play but not import or remove stems', () => {
      mocks.bands = [{ id: 'band-1', memberRoles: { 'user-1': 'viewer' } }];
      mocks.stems = [stem('s1', 'vocals')];
      render(<SongView song={baseSong} bandId="band-1" />);

      fireEvent.click(screen.getByRole('button', { name: 'Show stems' }));

      expect(screen.getByRole('button', { name: 'Play stems' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Mute Vocals' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Import stems/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    });
  });
});
