'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Download, Eye, Loader2 } from 'lucide-react';
import { OfficeViewer } from './office-viewer';
import { detectInlineOfficeKind } from './document-preview-kind';

type ApiPrefix = '/api/staff' | '/api/portal';

/**
 * Steuerbares Vorschau-Modal. Render-Pfad je MIME:
 *  - image/*                          → <img>
 *  - application/pdf                  → <iframe>
 *  - …spreadsheetml                  → XLSX-Inline-Viewer
 *  - DOCX                            → Download-Fallback (kein fremdes OOXML
 *                                      im privilegierten App-DOM)
 *  - sonst                            → Download-Fallback
 */
export function DocumentPreviewModal({
  documentId,
  documentTitle,
  apiPrefix = '/api/staff',
  onClose,
}: {
  documentId: string;
  documentTitle: string;
  apiPrefix?: ApiPrefix;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const [url, setUrl] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setUrl(null);
    (async () => {
      try {
        const res = await fetch(`${apiPrefix}/documents/${documentId}/preview-url`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { url: string; mimeType: string };
        if (cancelled) return;
        setUrl(data.url);
        setMimeType(data.mimeType);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [documentId, apiPrefix]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const officeKind = detectInlineOfficeKind(mimeType, documentTitle);
  const isImage = mimeType?.startsWith('image/');
  const isPdf = mimeType === 'application/pdf' || mimeType?.endsWith('pdf');

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl h-[90vh] bg-surface rounded-lg shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-3 border-b border-default">
          <h2 className="text-sm font-medium text-primary truncate flex-1">{documentTitle}</h2>
          <div className="flex items-center gap-2">
            <a
              href={`${apiPrefix}/documents/${documentId}/download`}
              className="text-muted hover:text-primary p-2"
              title="Herunterladen"
            >
              <Download className="h-4 w-4" />
            </a>
            <button
              type="button"
              onClick={onClose}
              className="text-muted hover:text-primary p-2"
              title="Schließen (Esc)"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-hidden bg-gray-100 dark:bg-gray-950">
          {loading && (
            <div className="h-full flex items-center justify-center">
              <Loader2 className="h-6 w-6 text-disabled animate-spin" />
            </div>
          )}
          {error && (
            <div className="h-full flex items-center justify-center text-sm text-red-700 dark:text-red-400 px-6 text-center">
              Vorschau konnte nicht geladen werden: {error}
            </div>
          )}
          {url && !loading && !error && (
            <>
              {isImage ? (
                // eslint-disable-next-line @next/next/no-img-element -- Document previews use short-lived blob URLs from the authenticated API.
                <img
                  src={url}
                  alt={documentTitle}
                  className="w-full h-full object-contain bg-white"
                />
              ) : isPdf ? (
                <iframe src={url} className="w-full h-full border-0" title={documentTitle} />
              ) : officeKind ? (
                <OfficeViewer url={url} />
              ) : (
                <div className="h-full flex flex-col items-center justify-center gap-3 text-muted">
                  <p className="text-sm">
                    Keine Inline-Vorschau für {mimeType ?? 'diesen Dateityp'}.
                  </p>
                  <a href={`${apiPrefix}/documents/${documentId}/download`} className="btn-primary">
                    <Download className="h-4 w-4" />
                    Herunterladen
                  </a>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );

  return mounted ? createPortal(modal, document.body) : null;
}

/** Auge-Button mit eigenem State (Kompatibilität für bestehende Aufrufer). */
export function DocumentPreviewButton({
  documentId,
  documentTitle,
  apiPrefix = '/api/staff',
}: {
  documentId: string;
  documentTitle: string;
  apiPrefix?: ApiPrefix;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-disabled hover:text-brand-700 dark:hover:text-brand-300 p-1"
        title="Vorschau"
      >
        <Eye className="h-4 w-4" />
      </button>
      {open && (
        <DocumentPreviewModal
          documentId={documentId}
          documentTitle={documentTitle}
          apiPrefix={apiPrefix}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
