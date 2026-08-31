'use client';
import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cropIdentityImage, loadIdentityImage, type IdentityImage } from '@/lib/gwg/identity-image';
import { identityViewports, type IdentityViewport } from '@/lib/gwg/identity-viewport';

interface SavedIdentityViewsProps {
  clientId: string;
  checkId: string;
  documentId: string;
  views: IdentityViewport[];
  active: boolean;
}

/** Read-only rendition of the saved view. The exact source version must still
 * match; opening this component never saves metadata or creates a derivative. */
export function SavedIdentityViews(props: SavedIdentityViewsProps) {
  if (!props.active) return null;
  // A changed source/view starts a fresh asynchronous preview with no stale status.
  const key = JSON.stringify([props.clientId, props.checkId, props.documentId, props.views]);
  return <SavedIdentityViewsContent key={key} {...props} />;
}

function SavedIdentityViewsContent({
  clientId,
  checkId,
  documentId,
  views,
}: SavedIdentityViewsProps) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const viewKey = JSON.stringify(views);
  useEffect(() => {
    const controller = new AbortController();
    let source: IdentityImage | null = null;
    let cancelled = false;
    const target = container.current;
    target?.replaceChildren();
    void (async () => {
      const storedViews = identityViewports(JSON.parse(viewKey));
      const query = new URLSearchParams({ clientId, checkId, documentId });
      const response = await fetch(`/api/staff/gwg/identity-source?${query}`, {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok)
        throw new Error(
          'Die gespeicherte Originalversion ist derzeit nicht verfügbar. Bitte das Original in der Akte prüfen.',
        );
      const versionId = response.headers.get('X-Identity-Version');
      if (!storedViews.length || storedViews.some((view) => view.versionId !== versionId)) {
        throw new Error(
          'Die Dateiversion hat sich geändert. Der gespeicherte Ausschnitt wird nicht auf eine andere Originalversion angewendet.',
        );
      }
      source = await loadIdentityImage(await response.blob());
      if (cancelled) return;
      for (const view of storedViews) {
        if (view.page > source.pages)
          throw new Error(
            'Die gespeicherte PDF-Seite ist nicht verfügbar. Bitte das Original prüfen.',
          );
        const page = await source.render(view.page);
        if (cancelled) return;
        const crop = cropIdentityImage(page, view);
        const label = `${view.side === 'front' ? 'Vorderseite' : 'Rückseite'} · Originalseite ${view.page}${view.rotation ? ` · ${view.rotation}° gedreht` : ''}`;
        const figure = document.createElement('figure');
        figure.className = 'space-y-2 p-3';
        const caption = document.createElement('figcaption');
        caption.className = 'text-xs font-medium text-secondary';
        caption.textContent = label;
        crop.className = 'max-h-[65vh] max-w-full object-contain';
        crop.setAttribute('role', 'img');
        crop.setAttribute('aria-label', label);
        figure.append(caption, crop);
        target?.append(figure);
      }
    })()
      .catch((failure) => {
        if (!cancelled) {
          target?.replaceChildren();
          setError(
            failure instanceof Error
              ? failure.message
              : 'Der gespeicherte Ausschnitt konnte nicht geladen werden.',
          );
        }
      })
      .finally(() => {
        source?.dispose();
        source = null;
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
      target?.replaceChildren();
    };
  }, [attempt, checkId, clientId, documentId, viewKey]);
  return (
    <div className="w-full">
      {loading && (
        <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted">
          <Loader2 className="h-5 w-5 animate-spin" />
          Gespeicherten Ausschnitt laden…
        </div>
      )}
      {error && (
        <div role="alert" className="space-y-2 p-4 text-sm text-red-700">
          <p>{error}</p>
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => {
              setLoading(true);
              setError(null);
              setAttempt((value) => value + 1);
            }}
          >
            Erneut laden
          </button>
        </div>
      )}
      <div ref={container} className={views.length > 1 ? 'grid gap-3 lg:grid-cols-2' : ''} />
    </div>
  );
}
