/**
 * Datei-Download aus einer Export-Route per fetch (Muster wie
 * InvoiceFormatDownload): Bei Fehlern liefert die Route JSON, das ein
 * `<a href>` als ganze Seite anzeigen würde. Stattdessen kommt die Meldung
 * (`message`, sonst `error`) zurück und wird neben dem Auslöser angezeigt.
 */

/** Dateiname aus Content-Disposition; bevorzugt die UTF-8-Form (`filename*`). */
export function downloadFilename(disposition: string | null, fallback: string): string {
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? '')?.[1];
  if (utf8) {
    try {
      return decodeURIComponent(utf8);
    } catch {
      // ungültige Prozentkodierung: einfache Form verwenden
    }
  }
  return /filename="([^"]+)"/i.exec(disposition ?? '')?.[1] ?? fallback;
}

/** Lädt `href` und speichert die Antwort als Datei; liefert bei Fehlern die Meldung. */
export async function downloadFromRoute(
  href: string,
  fallbackName: string,
): Promise<string | null> {
  try {
    const res = await fetch(href, { cache: 'no-store' });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        message?: string;
        error?: string;
      } | null;
      return data?.message ?? data?.error ?? `Fehler (${res.status})`;
    }
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = downloadFilename(res.headers.get('content-disposition'), fallbackName);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return null;
  } catch {
    return 'Netzwerkfehler — bitte erneut versuchen.';
  }
}
