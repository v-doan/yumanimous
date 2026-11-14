/**
 * Copies text, resolving true on success. Tries the Clipboard API first, then the
 * old select-and-copy trick: the Clipboard API only exists on https (or localhost),
 * so a phone testing over the LAN address (http://192.168...) has none, and some
 * in-app browsers block it even on https.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Blocked: try the fallback below.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  // Off-screen but still selectable; a 16px font stops iOS zooming in.
  area.style.cssText = 'position:fixed;top:0;left:-9999px;font-size:16px';
  document.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange(0, text.length); // iOS ignores select() on its own.
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
