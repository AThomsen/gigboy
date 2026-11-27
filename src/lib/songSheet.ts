import { isDemoMode } from './demo/demoMode';
import * as demoStore from './demo/demoStore';

/**
 * A song's PDF sheet: one of its PDF attachments shown as the chart in place of the ChordPro
 * text — `PUT /api/bands/:bandId/songs/:songId/sheet` (see server/routes/songSheet.ts). Editors
 * only; not a song edit, so no revision.
 */
export async function saveSongSheet(bandId: string, songId: string, attachmentId: string | null): Promise<string | null> {
  if (isDemoMode) return demoStore.setSongSheet(bandId, songId, attachmentId);
  const response = await fetch(`/api/bands/${bandId}/songs/${songId}/sheet`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attachmentId }),
  });
  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // not JSON
    }
    throw new Error(message);
  }
  const data = (await response.json()) as { sheetAttachmentId: string | null };
  return data.sheetAttachmentId;
}

/** Where the sheet's PDF is read from (the attachment's download URL). */
export function songSheetUrl(bandId: string, songId: string, attachmentId: string): string | null {
  if (isDemoMode) {
    return demoStore.listAttachments(bandId, songId).find((a) => a.id === attachmentId)?.downloadUrl ?? null;
  }
  return `/api/bands/${bandId}/songs/${songId}/attachments/${attachmentId}/download`;
}
