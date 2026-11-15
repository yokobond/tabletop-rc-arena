/** The browser side of arena files: handing one to the person as a download, and reading one they picked. */

/** Larger than any arena file this app writes (a layout and one table picture). */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** A file name the person will recognise, without the characters file systems refuse. */
export function arenaFileName(name: string) {
  // eslint-disable-next-line no-control-regex
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return `${safe || 'arena'}.arena.json`;
}

export function downloadText(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The download has started by the next turn of the event loop; Safari needs the URL until then.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The text of a picked file, or null when it is too large to be an arena. */
export async function readFileText(file: Blob): Promise<string | null> {
  if (file.size > MAX_FILE_BYTES) return null;
  return await file.text();
}
