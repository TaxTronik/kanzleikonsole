'use client';

// =============================================================================
// Download für Rechnungs-Exportformate (ZUGFeRD-PDF / XRechnung-XML) — bewusst
// KEIN plain `<a href>`: bei Fehler liefert die API sonst JSON zurück und der
// Browser ersetzt das komplette Fenster durch die JSON-Anzeige ("Fenster
// verschwindet"). Diese Komponente fetcht client-seitig, zeigt einen Lade-
// Zustand, löst bei Erfolg den Download über einen Blob aus und gibt Fehler
// INLINE aus — die Seite bleibt sichtbar.
// =============================================================================

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileCode, Loader2 } from 'lucide-react';

export function InvoiceFormatDownload({
  href,
  label,
  title,
}: {
  href: string;
  label: string;
  title?: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<'idle' | 'loading'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function onDownload(e: React.MouseEvent) {
    e.preventDefault();
    if (status === 'loading') return;
    setStatus('loading');
    setError(null);
    try {
      const res = await fetch(href, { cache: 'no-store' });
      if (res.ok) {
        const blob = await res.blob();
        // Dateiname aus Content-Disposition (Fallback: download).
        const cd = res.headers.get('content-disposition') ?? '';
        const m = /filename="?([^";]+)"?/i.exec(cd);
        const filename = m?.[1] ?? 'download';
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setStatus('idle');
        router.refresh();
      } else {
        let message = `Fehler (${res.status})`;
        try {
          const data = (await res.json()) as { message?: string; error?: string };
          if (data.message) message = data.message;
          else if (data.error) message = data.error;
        } catch {
          // kein JSON-Body
        }
        setStatus('idle');
        setError(message);
      }
    } catch {
      setStatus('idle');
      setError('Netzwerkfehler — bitte erneut versuchen.');
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={onDownload}
        disabled={status === 'loading'}
        className="btn-secondary disabled:opacity-60"
        title={title}
      >
        {status === 'loading' ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <FileCode className="h-4 w-4" />
        )}
        {status === 'loading' ? 'bereitet vor …' : label}
      </button>
      {error && <p className="text-xs text-red-700 dark:text-red-400 max-w-xs">{error}</p>}
    </div>
  );
}
