/**
 * Replaces `start`..`end` of the textarea with `text` the way typing would: through the
 * browser's own edit history, so Ctrl+Z / Ctrl+Y undo and redo it like any keystroke. The
 * edit fires the textarea's input event, which updates the form state as typing does. Where
 * the browser can't do that (e.g. jsdom), the new value goes straight to `onChange`.
 * Afterwards the cursor sits at `cursorPos`, or `cursorPos`..`selectEnd` is selected.
 */
export function replaceTextareaRange(
  textarea: HTMLTextAreaElement,
  start: number,
  end: number,
  text: string,
  value: string,
  onChange: (value: string) => void,
  cursorPos: number = start + text.length,
  selectEnd: number = cursorPos,
) {
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(start, end);
  let inserted: boolean;
  try {
    inserted = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
  } catch {
    inserted = false;
  }
  if (!inserted) onChange(value.slice(0, start) + text + value.slice(end));
  requestAnimationFrame(() => {
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(cursorPos, selectEnd);
  });
}

/**
 * Inserts a chord tag at the current selection. If text is selected (e.g. a
 * marked syllable), the tag goes immediately before it and the selected text
 * is preserved — mirroring how the Section toolbar buttons wrap a selection,
 * rather than replacing it the way a plain cursor-insert would.
 */
export function insertChordAtSelection(
  textarea: HTMLTextAreaElement,
  chordName: string,
  value: string,
  onChange: (value: string) => void,
) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const tag = `[${chordName}]`;
  replaceTextareaRange(textarea, start, start, tag, value, onChange, end + tag.length);
}
