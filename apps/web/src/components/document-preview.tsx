'use client';

import { useEffect, useState } from 'react';
import { X, Download, Eye, Loader2 } from 'lucide-react';
import { OfficeViewer } from './office-viewer';
import { detectInlineOfficeKind } from './document-preview-kind';
import { renderMarkdown } from '@/lib/markdown';
import { Modal } from '@/components/ui/modal';

// Prose-Styling für die Markdown-Inline-Vorschau (z. B. im Aktenregal
// gespeicherte Rechercheergebnisse). renderMarkdown escapet jeden Textblock —
// kein HTML-Passthrough, daher ist dangerouslySetInnerHTML sicher.
const MD_PROSE_CLASS =
  'text-sm text-secondary space-y-2 leading-relaxed ' +
  '[&_h1]:text-lg [&_h1]:font-bold [&_h1]:text-primary [&_h1]:mt-4 ' +
  '[&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-primary [&_h2]:mt-4 ' +
  '[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-primary [&_h3]:mt-3 ' +
  '[&_p]:my-2 [&_ul]:list-disc [&_ul]:ml-5 [&_ol]:list-decimal [&_ol]:ml-5 [&_li]:my-1 ' +
  '[&_a]:text-brand-700 [&_a:hover]:underline ' +
  '[&_code]:bg-gray-100 dark:[&_code]:bg-gray-800 [&_code]:px-1 [&_code]:rounded ' +
  '[&_pre]:bg-gray-100 dark:[&_pre]:bg-gray-800 [&_pre]:p-2 [&_pre]:rounded [&_pre]:overflow-x-auto ' +
  '[&_blockquote]:border-l-4 [&_blockquote]:border-strong [&_blockquote]:pl-3 [&_blockquote]:text-muted ' +
  '[&_hr]:my-4 [&_hr]:border-border-subtle ' +
  '[&_table]:w-full [&_table]:border-collapse [&_table]:my-3 ' +
  '[&_th]:border [&_th]:border-default [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_th]:text-primary ' +
  '[&_td]:border [&_td]:border-default [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top';

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
  const [url, setUrl] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string | null>(null);
  // Gespeicherter Dokumenttyp — nur fuer die Wahl des eigenen Viewers. Der
  // Transport-Typ oben bleibt sanitisiert (Inline-Whitelist), damit XLSX nicht
  // ueber diesen Weg doch vom Browser gerendert wird.
  const [documentMimeType, setDocumentMimeType] = useState<string | null>(null);
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
        const data = (await res.json()) as {
          url: string;
          mimeType: string;
          documentMimeType?: string;
        };
        if (cancelled) return;
        setUrl(data.url);
        setMimeType(data.mimeType);
        setDocumentMimeType(data.documentMimeType ?? null);
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

  const officeKind = detectInlineOfficeKind(documentMimeType ?? mimeType, documentTitle);
  const isImage = mimeType?.startsWith('image/');
  const isPdf = mimeType === 'application/pdf' || mimeType?.endsWith('pdf');
  const isMarkdown = mimeType === 'text/markdown' || /\.(md|markdown)$/i.test(documentTitle ?? '');

  // Markdown: Datei-Text laden und geparst rendern (statt Download-Fallback).
  const [mdText, setMdText] = useState<string | null>(null);
  useEffect(() => {
    if (!isMarkdown || !url) return;
    let cancelled = false;
    setMdText(null);
    fetch(url)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((text) => {
        if (!cancelled) setMdText(text);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [isMarkdown, url]);

  const modal = (
    <Modal
      title={documentTitle}
      onClose={onClose}
      panelClassName="w-full max-w-5xl h-[90vh] bg-surface rounded-lg shadow-xl flex flex-col"
      backdropClassName="bg-black/60 p-4"
      showCloseButton={false}
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
            {isMarkdown ? (
              <div className="h-full overflow-y-auto bg-surface px-8 py-6">
                {mdText === null ? (
                  <div className="h-full flex items-center justify-center">
                    <Loader2 className="h-6 w-6 text-disabled animate-spin" />
                  </div>
                ) : (
                  <div
                    className={MD_PROSE_CLASS}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(mdText) }}
                  />
                )}
              </div>
            ) : isImage ? (
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
                  Keine Inline-Vorschau für {documentMimeType ?? mimeType ?? 'diesen Dateityp'}.
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
    </Modal>
  );

  return modal;
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
