import { useLocation, Navigate } from 'react-router-dom';
import { useBands } from '../context/BandsContext';
import AddSongForm from '../components/AddSongForm';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { dataClient } from '../lib/dataClient';
import type { Song } from '../types';

type AddSongScopeState = {
  addSongScope?: {
    kind?: 'band';
    bandId?: string;
  };
  initialSongListId?: string;
  /** Open the Ultimate Guitar import dialog on arrival (the Library's Ultimate Guitar button). */
  openUltimateGuitar?: boolean;
};

export default function AddSongPage() {
  useDocumentTitle('Add Song');
  const location = useLocation();
  const {
    bands,
    bandSongListsByBandId,
    addSongToBandLibrary,
    addSongToBandSongList,
    saveBandSongSheet,
  } = useBands();

  const pageState = location.state as AddSongScopeState | null;
  const requestedScope = pageState?.addSongScope;
  const hasScopedBand = requestedScope?.kind === 'band'
    && typeof requestedScope.bandId === 'string'
    && bands.some((band) => band.id === requestedScope.bandId);
  const activeBandId = hasScopedBand ? requestedScope?.bandId ?? null : null;

  if (!activeBandId) {
    return <Navigate to="/" replace />;
  }

  const bandId: string = activeBandId;

  const songListOptions = (bandSongListsByBandId[bandId] ?? []).map((list) => ({
    id: list.id,
    label: list.name,
  }));

  const initialSongListId = pageState?.initialSongListId ?? '';
  const songPageState = {
    backTo: `/bands/${bandId}/library`,
    backLabel: 'Band library',
    bandId,
  };

  async function handleAdd(song: Song): Promise<string | null> {
    return addSongToBandLibrary(bandId, song);
  }

  async function handleSaveSheet(songId: string, file: File): Promise<string | null> {
    try {
      const attachment = await dataClient.bandAttachments.upload(bandId, songId, file);
      return await saveBandSongSheet(bandId, songId, attachment.id);
    } catch (err) {
      return err instanceof Error ? err.message : 'Failed to save the PDF.';
    }
  }

  function handleSongListChange(songListId: string, _previousSongListId: string, songId: string) {
    void addSongToBandSongList(bandId, songListId, songId);
  }

  return (
    <AddSongForm
      onSave={handleAdd}
      songListOptions={songListOptions}
      initialSongListId={initialSongListId}
      onSongListChange={handleSongListChange}
      songPageState={songPageState}
      openUltimateGuitarOnMount={pageState?.openUltimateGuitar === true}
      onSaveSheet={handleSaveSheet}
    />
  );
}
