import { FormEvent, useEffect, useState } from 'react';
import { Link2, Lock, Search, Star, X } from 'lucide-react';
import { dataClient } from '../lib/dataClient';
import type { UltimateGuitarSearchResult, UltimateGuitarTab } from '../lib/dataClient/types';

interface Props {
  /** Text to start the search box with, such as the song's current artist and title. */
  initialQuery?: string;
  onImport: (tab: UltimateGuitarTab) => void;
  onClose: () => void;
}

const PAID_HINT =
  'Pro and Official versions need a UG license, so Gigboy can’t read them. In the Ultimate Guitar app, open the song and use Share → Save to Files, then pick that file with Import file.';

function formatVotes(votes: number): string {
  return votes >= 1000 ? `${(votes / 1000).toFixed(votes >= 10_000 ? 0 : 1)}k` : String(votes);
}

/** Search Ultimate Guitar, or paste a link to a song there, and hand the chosen song to the form. */
export default function UltimateGuitarImportModal({ initialQuery = '', onImport, onClose }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [link, setLink] = useState('');
  const [results, setResults] = useState<UltimateGuitarSearchResult[] | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [searching, setSearching] = useState(false);
  const [loadingUrl, setLoadingUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  async function runSearch(nextPage: number) {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setError('Type at least 2 characters to search.');
      return;
    }
    setSearching(true);
    setError('');
    setNotice('');
    try {
      const data = await dataClient.ultimateGuitar.search(trimmed, nextPage);
      setResults((previous) => (nextPage === 1 || !previous ? data.results : [...previous, ...data.results]));
      setPage(data.page);
      setTotalPages(data.totalPages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      setSearching(false);
    }
  }

  async function importFrom(url: string) {
    setLoadingUrl(url);
    setError('');
    setNotice('');
    try {
      onImport(await dataClient.ultimateGuitar.getTab(url));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import that song.');
      setLoadingUrl(null);
    }
  }

  function handleSearch(e: FormEvent) {
    e.preventDefault();
    void runSearch(1);
  }

  function handleLink(e: FormEvent) {
    e.preventDefault();
    if (!link.trim()) return;
    void importFrom(link.trim());
  }

  const busy = searching || loadingUrl !== null;

  return (
    <div className="chord-finder-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="chord-finder-modal ug-import-modal" role="dialog" aria-modal="true" aria-label="Import from Ultimate Guitar">
        <div className="chord-finder-modal-header">
          <span className="chord-finder-modal-title">Import from Ultimate Guitar</span>
          <button type="button" className="chord-finder-modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="chord-finder-modal-body ug-import-body">
          <form className="ug-import-row" onSubmit={handleSearch}>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Song or artist"
              aria-label="Search Ultimate Guitar"
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              disabled={busy}
            />
            <button type="submit" className="btn btn--primary" disabled={busy}>
              <Search size={15} aria-hidden="true" /> {searching ? 'Searching…' : 'Search'}
            </button>
          </form>

          <form className="ug-import-row" onSubmit={handleLink}>
            <input
              type="url"
              inputMode="url"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="…or paste a link to a song on ultimate-guitar.com"
              aria-label="Ultimate Guitar song link"
              disabled={busy}
            />
            <button type="submit" className="btn btn--secondary" disabled={busy || !link.trim()}>
              <Link2 size={15} aria-hidden="true" /> {loadingUrl === link.trim() ? 'Importing…' : 'Import'}
            </button>
          </form>

          {error && <p className="ug-import-error" role="alert">{error}</p>}
          {notice && <p className="ug-import-notice" role="status">{notice}</p>}

          {results !== null && (
            results.length === 0 ? (
              <p className="ug-import-empty">No songs found.</p>
            ) : (
              <ul className="ug-import-results">
                {results.map((result) => (
                  <li key={result.url}>
                    <button
                      type="button"
                      className={`ug-import-result${result.paid ? ' ug-import-result--paid' : ''}`}
                      disabled={busy}
                      onClick={() => (result.paid ? setNotice(PAID_HINT) : void importFrom(result.url))}
                    >
                      <span className="ug-import-result-main">
                        <strong>{result.title}</strong>
                        <span>{result.artist}</span>
                      </span>
                      <span className="ug-import-result-meta">
                        {result.paid && <Lock size={12} aria-hidden="true" />}
                        {result.type}
                        {result.version && result.version > 1 ? ` v${result.version}` : ''}
                        {result.rating !== null && result.votes ? (
                          <span className="ug-import-rating">
                            <Star size={12} aria-hidden="true" /> {result.rating.toFixed(1)} ({formatVotes(result.votes)})
                          </span>
                        ) : null}
                        {loadingUrl === result.url && <span>Importing…</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}
          {results !== null && page < totalPages && (
            <button type="button" className="btn btn--ghost ug-import-more" disabled={busy} onClick={() => void runSearch(page + 1)}>
              {searching ? 'Loading…' : 'More results'}
            </button>
          )}

          <p className="ug-import-footnote">
            Using the Ultimate Guitar app, or have a Pro/Official version? In the app, use Share → Save
            to Files, then choose that file with <strong>Import file</strong>.
          </p>
        </div>
      </div>
    </div>
  );
}
