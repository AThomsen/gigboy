import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { X } from 'lucide-react';

interface Props {
  url: string;
  title?: string;
  onClose: () => void;
}

/** Shows an invite link as a scannable QR code so someone in the room can join from their phone. */
export default function InviteQrModal({ url, title = 'Scan to join', onClose }: Props) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Always dark-on-white regardless of theme — phone cameras read that most reliably.
    QRCode.toDataURL(url, { width: 320, margin: 2, errorCorrectionLevel: 'M' })
      .then((result) => { if (!cancelled) setDataUrl(result); })
      .catch(() => { if (!cancelled) setDataUrl(null); });
    return () => { cancelled = true; };
  }, [url]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return (
    <div className="chord-finder-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="chord-finder-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="chord-finder-modal-header">
          <span className="chord-finder-modal-title">{title}</span>
          <button className="chord-finder-modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="chord-finder-modal-body invite-qr-body">
          {dataUrl ? (
            <img className="invite-qr-image" src={dataUrl} alt="QR code for the invite link" width={320} height={320} />
          ) : (
            <div className="invite-qr-image" aria-hidden="true" />
          )}
          <p className="invite-qr-url">{url}</p>
        </div>
      </div>
    </div>
  );
}
