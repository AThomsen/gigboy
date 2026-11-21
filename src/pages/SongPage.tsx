import { useLocation, useParams, Link, Navigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import SongView from '../components/SongView';
import { useSongBand } from '../hooks/useSongBand';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

type SongPageState = {
  backTo?: string;
  backLabel?: string;
  bandId?: string;
};

export default function SongPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const pageState = location.state as SongPageState | null;
  const { bandId, song, loading } = useSongBand(id);

  useDocumentTitle(song ? song.title : loading ? 'Loading song' : 'Song not found');

  if (loading) {
    return <p className="bands-status">Loading song…</p>;
  }

  if (!bandId) {
    return <Navigate to="/" replace />;
  }

  const backTo = pageState?.backTo ?? '/';
  const backLabel = pageState?.backLabel?.trim();
  const backLinkText = backLabel ? `Return to ${backLabel}` : 'All songs';

  if (!song) {
    return (
      <div className="not-found">
        <p>Song not found.</p>
        <Link to={backTo} className="back-link"><ArrowLeft size={16} /> {backLinkText}</Link>
      </div>
    );
  }

  return (
    <div>
      <Link to={backTo} className="back-link"><ArrowLeft size={16} /> {backLinkText}</Link>
      <SongView song={song} bandId={bandId} />
    </div>
  );
}
