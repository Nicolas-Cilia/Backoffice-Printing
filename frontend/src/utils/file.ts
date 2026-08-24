/**
 * Opens a generated blob (typically a PDF) in a new tab, falling back to a
 * download when the browser blocks the popup. `downloadName` names the file
 * on that fallback path only.
 */
export function openBlobInNewTab(blob: Blob, downloadName: string): void {
  const url = window.URL.createObjectURL(blob);
  // Do NOT pass `noopener,noreferrer`: per the WindowFeatures spec, `noopener`
  // forces window.open to return `null` even on success, which made the
  // `if (!win)` popup-block fallback below fire on EVERY click — so the blob
  // tab opened (downloading a random-named PDF on systems without an inline
  // viewer) AND the `<a download>` fallback fired (downloading a second copy).
  // Two identical PDFs per click — issue #1628.
  // The blob is same-origin, the destination is a passive PDF tab with no
  // script context, and `noreferrer` is a no-op for blob URLs, so dropping
  // these flags has no security impact.
  const win = window.open(url, '_blank');
  if (!win) {
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
  setTimeout(() => window.URL.revokeObjectURL(url), 60_000);
}

/**
 * Formats a byte count into a human-readable string (e.g. `1.5 MB`).
 *
 * @param bytes - The number of bytes to format.
 * @returns A formatted string with the appropriate unit (B, KB, MB, GB, or TB).
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  const size = bytes / Math.pow(k, i);

  // No decimals for bytes, 1 decimal for larger units
  return i === 0
    ? `${size} ${units[i]}`
    : `${size.toFixed(1)} ${units[i]}`;
}
