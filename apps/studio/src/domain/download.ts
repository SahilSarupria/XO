/**
 * Hands text to the browser as a file download. The text is written exactly as given: an audit evidence pack is
 * delivered byte-for-byte as the server produced it, never re-serialized here.
 */
export function downloadText(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
