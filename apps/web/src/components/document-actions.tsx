'use client';

// =============================================================================
// Datei-Aktionen: Auge (Ansicht) + Pfeil (Download), nebeneinander.
//
// Vorher stand an den Rechnungen ein Textlink „Öffnen", der auf die
// Download-Route zeigte — die setzt immer `Content-Disposition: attachment`,
// der Browser speicherte also, statt zu zeigen. Beides sind verschiedene
// Vorgänge und werden auch getrennt protokolliert (`document.preview` bzw.
// `document.download`), deshalb hier zwei Schaltflächen statt einer.
// =============================================================================

import { Download } from 'lucide-react';
import { DocumentPreviewButton } from './document-preview';
import { canPreviewInline } from './document-preview-kind';

type ApiPrefix = '/api/staff' | '/api/portal';

export function DocumentActions({
  documentId,
  documentTitle,
  mimeType,
  apiPrefix = '/api/staff',
}: {
  documentId: string;
  documentTitle: string;
  mimeType: string | null;
  apiPrefix?: ApiPrefix;
}) {
  return (
    <div className="flex items-center gap-1 shrink-0">
      {canPreviewInline(mimeType, documentTitle) && (
        <DocumentPreviewButton
          documentId={documentId}
          documentTitle={documentTitle}
          apiPrefix={apiPrefix}
        />
      )}
      <a
        href={`${apiPrefix}/documents/${documentId}/download`}
        className="text-disabled hover:text-brand-700 dark:hover:text-brand-300 p-1"
        title="Herunterladen"
        aria-label={`${documentTitle} herunterladen`}
      >
        <Download className="h-4 w-4" />
      </a>
    </div>
  );
}
