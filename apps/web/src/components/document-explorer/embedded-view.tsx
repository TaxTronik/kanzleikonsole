'use client';
// =============================================================================
// DocumentExplorer — DIE Dokumentenverwaltung (konsolidiert aus den früheren
// Komponenten DocumentBrowser + DocumentsManager).
//
// Aufgeteilt aus einer 1547-Zeilen-Datei — rein mechanisch:
//   index.tsx         Weiche browser/embedded + öffentliche Typen
//   types.ts          ManagedDoc, BrowserProps, EmbeddedProps
//   ops.tsx           useDocumentOps + geteilte Dialoge/Badges beider Varianten
//   browser-view.tsx  /staff/documents (URL-getrieben, Explorer-Stil)
//   embedded-view.tsx Mandanten-Tab + Aktenregal (lokal gefiltert, Tabelle)
// =============================================================================

import { useDeferredValue, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Folder,
  FileText,
  Search,
  FolderPlus,
  Download,
  RotateCcw,
  Trash2,
  Pencil,
  FolderInput,
  Tag,
  Share2,
  EyeOff,
} from 'lucide-react';
import { DocumentUploadButton } from '@/components/document-upload-button';
import { DeleteDocModal, MoveDialog } from '@/components/document-dialogs';
import { FolderTreePicker } from '@/components/folder-tree-picker';
import { deleteFolderAction } from '@/app/staff/(protected)/documents/folder-actions';
import {
  descendants,
  fmtBytes,
  fmtDate,
  type FolderNode,
} from '@/components/document-browser-utils';
import { buildFolderDocumentCounts } from '@/components/document-explorer-performance';
import { DOCUMENT_CLASSIFICATION_LABELS } from '@/lib/domain-labels';

import { OpErrorBanner, ShareBadge, TruncationHint, type DocumentOps } from './ops';
import type { EmbeddedProps, ManagedDoc } from './types';

// ---------------------------------------------------------------------------
// Variante „embedded" — Mandanten-Tab + Aktenregal (lokal gefiltert, Tabelle)
// ---------------------------------------------------------------------------

export function EmbeddedView({
  clientId,
  folders,
  documents,
  scopeLabel,
  canUpload = true,
  analysisId,
  truncated,
  totalCount,
  serverDeleted,
  ops,
}: Omit<EmbeddedProps, 'variant'> & { ops: DocumentOps }) {
  const { router, busy } = ops;
  const [sel, setSel] = useState<string | 'all' | 'none'>('all');
  const [q, setQ] = useState('');
  const deferredQ = useDeferredValue(q);
  const [moveDoc, setMoveDoc] = useState<ManagedDoc | null>(null);
  const [confirmDelDoc, setConfirmDelDoc] = useState<ManagedDoc | null>(null);

  const { active, deleted } = useMemo(() => {
    const nextActive: ManagedDoc[] = [];
    const nextDeleted: ManagedDoc[] = [];
    for (const document of documents) {
      (document.deletedAt ? nextDeleted : nextActive).push(document);
    }
    return { active: nextActive, deleted: nextDeleted };
  }, [documents]);
  const [localShowDeleted, setLocalShowDeleted] = useState(false);
  const showDeleted = serverDeleted?.showDeleted ?? localShowDeleted;
  const countDocuments = showDeleted ? deleted : active;

  // Ein Durchlauf statt eines Full-Scans je Ordnerzeile. Dokumente eines
  // Unterordners zaehlen dabei wie bisher auch fuer alle Vorfahren.
  const folderCounts = useMemo(
    () => buildFolderDocumentCounts(folders, countDocuments),
    [countDocuments, folders],
  );

  const countIn = (fid: string | 'all' | 'none'): number => {
    if (fid === 'all') return countDocuments.length;
    if (fid === 'none') return folderCounts.withoutFolder;
    return folderCounts.byId.get(fid) ?? 0;
  };

  const shown = useMemo(() => {
    const base = showDeleted ? deleted : active;
    let list =
      sel === 'all'
        ? base
        : sel === 'none'
          ? base.filter((d) => !d.folderId)
          : (() => {
              const ids = descendants(folders, sel);
              return base.filter((d) => d.folderId && ids.has(d.folderId));
            })();
    const needle = deferredQ.trim().toLowerCase();
    if (needle) list = list.filter((d) => d.title.toLowerCase().includes(needle));
    return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [showDeleted, deleted, active, sel, folders, deferredQ]);

  function deleteFolder(f: FolderNode) {
    ops.setConfirmState({
      title: 'Ordner löschen',
      message: `Ordner „${f.name}" löschen?\n\nUnterordner und Dokumente werden eine Ebene nach oben verschoben. Es wird kein Dokument gelöscht.`,
      confirmLabel: 'Löschen',
      busyLabel: 'Löscht…',
      danger: true,
      action: async () => {
        const r = await deleteFolderAction({ folderId: f.id });
        if (r.ok) {
          if (sel === f.id) setSel('all');
          router.refresh();
        }
        return r;
      },
    });
  }

  // Hover-Aktionen + Zähler pro Ordnerzeile (im gemeinsamen FolderTreePicker).
  function folderRowExtra(f: FolderNode) {
    return (
      <>
        <span className="text-xs text-disabled">{countIn(f.id) || ''}</span>
        <span className="hidden group-hover:flex items-center gap-0.5">
          <button
            type="button"
            title="Unterordner"
            onClick={(e) => {
              e.stopPropagation();
              ops.setCreateFolder({
                parentId: f.id,
                title: 'Neuer Unterordner',
                placeholder: 'Name des Unterordners',
              });
            }}
            className="text-disabled hover:text-brand-700"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="Umbenennen"
            onClick={(e) => {
              e.stopPropagation();
              ops.setRenameTarget({ id: f.id, name: f.name });
            }}
            className="text-disabled hover:text-brand-700"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title="Löschen (Inhalt rückt eine Ebene hoch)"
            onClick={(e) => {
              e.stopPropagation();
              deleteFolder(f);
            }}
            className="text-disabled hover:text-red-600"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </span>
      </>
    );
  }

  return (
    <div className="grid grid-cols-[240px_1fr] gap-4">
      {/* ---- Ordnerbaum ---- */}
      <div className="card p-2 self-start">
        <div className="flex items-center justify-between px-2 py-1.5 mb-1">
          <span className="text-xs font-semibold text-muted uppercase tracking-wide">Ordner</span>
          <button
            type="button"
            title="Ordner anlegen"
            onClick={() =>
              ops.setCreateFolder({
                parentId: null,
                title: 'Neuer Ordner',
                placeholder: 'Name des neuen Ordners',
              })
            }
            className="text-disabled hover:text-brand-700"
          >
            <FolderPlus className="h-4 w-4" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => setSel('all')}
          className={`w-full flex items-center gap-1.5 rounded px-2 py-1 text-sm ${
            sel === 'all' ? 'bg-brand-50 text-brand-700' : 'hover:bg-gray-50 text-secondary'
          }`}
        >
          <FileText className="h-4 w-4" />
          <span className="flex-1 text-left">Alle</span>
          <span className="text-xs text-disabled">{countDocuments.length || ''}</span>
        </button>
        <button
          type="button"
          onClick={() => setSel('none')}
          className={`w-full flex items-center gap-1.5 rounded px-2 py-1 text-sm ${
            sel === 'none' ? 'bg-brand-50 text-brand-700' : 'hover:bg-gray-50 text-secondary'
          }`}
        >
          <Folder className="h-4 w-4 text-disabled" />
          <span className="flex-1 text-left">Ohne Ordner</span>
          <span className="text-xs text-disabled">{countIn('none') || ''}</span>
        </button>
        <div className="mt-1 border-t border-subtle pt-1">
          {folders.length === 0 ? (
            <p className="px-2 py-3 text-xs text-disabled">
              Noch keine Ordner. Oben „+" für den ersten Ordner.
            </p>
          ) : (
            <FolderTreePicker
              folders={folders}
              value={sel !== 'all' && sel !== 'none' ? sel : null}
              onSelect={(id) => {
                if (id) setSel(id);
              }}
              indent={14}
              rowExtra={folderRowExtra}
            />
          )}
        </div>
      </div>

      {/* ---- Dokumentenliste ---- */}
      <div>
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="h-4 w-4 text-disabled absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="In Auswahl suchen…"
              className="input pl-9"
            />
          </div>
          {serverDeleted ? (
            <Link
              href={showDeleted ? serverDeleted.activeHref : serverDeleted.deletedHref}
              scroll={false}
              className={`text-xs px-3 py-1.5 rounded ${
                showDeleted ? 'bg-brand-50 text-brand-700' : 'text-muted hover:text-secondary'
              }`}
            >
              {showDeleted ? 'Aktive anzeigen' : 'Gelöschte anzeigen'}
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => setLocalShowDeleted((value) => !value)}
              className={`text-xs px-3 py-1.5 rounded ${
                showDeleted ? 'bg-brand-50 text-brand-700' : 'text-muted hover:text-secondary'
              }`}
            >
              {showDeleted
                ? `Gelöscht (${deleted.length})`
                : `Gelöschte anzeigen (${deleted.length})`}
            </button>
          )}
          {canUpload && (
            <DocumentUploadButton
              clientId={clientId ?? undefined}
              folderId={
                typeof sel === 'string' && sel !== 'all' && sel !== 'none' ? sel : undefined
              }
              analysisId={analysisId}
              defaultClassification={clientId ? 'GOBD_INVOICE' : 'GENERAL'}
              buttonLabel="Hochladen"
              buttonClassName="btn-primary text-xs py-1.5"
            />
          )}
        </div>

        <OpErrorBanner ops={ops} />

        {truncated && <TruncationHint shown={documents.length} totalCount={totalCount} />}

        <div className="card overflow-hidden">
          {shown.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <FileText className="h-10 w-10 text-disabled mx-auto mb-2" />
              <p className="text-sm text-disabled">
                {showDeleted ? 'Keine gelöschten Dokumente.' : 'Keine Dokumente in dieser Auswahl.'}
              </p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-default">
                  <th className="text-left px-5 py-2.5 text-xs font-medium text-muted uppercase">
                    Titel
                  </th>
                  <th className="text-left px-5 py-2.5 text-xs font-medium text-muted uppercase">
                    Klassifikation
                  </th>
                  <th className="text-left px-5 py-2.5 text-xs font-medium text-muted uppercase">
                    Größe
                  </th>
                  <th className="text-left px-5 py-2.5 text-xs font-medium text-muted uppercase">
                    Datum
                  </th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {shown.map((d) => (
                  <tr
                    key={d.id}
                    className="hover:bg-gray-50"
                    style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 44px' }}
                  >
                    <td className="px-5 py-3 font-medium text-primary">
                      <button
                        type="button"
                        onClick={() => ops.setPreviewDoc({ id: d.id, name: d.title })}
                        className="text-left hover:underline"
                        title="Vorschau öffnen"
                      >
                        {d.title}
                      </button>
                    </td>
                    <td className="px-5 py-3 text-secondary">
                      <span className="inline-flex items-center gap-1.5">
                        {d.typeName ||
                          DOCUMENT_CLASSIFICATION_LABELS[d.classification] ||
                          d.classification}
                        {!d.deletedAt && <ShareBadge shared={d.shared} />}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-secondary">{fmtBytes(d.sizeBytes)}</td>
                    <td className="px-5 py-3 text-secondary">{fmtDate(d.createdAt)}</td>
                    <td className="px-5 py-3 text-right whitespace-nowrap">
                      {!d.deletedAt && (
                        <>
                          <button
                            type="button"
                            disabled={busy}
                            title={
                              d.shared
                                ? 'Freigabe für Mandant zurückziehen'
                                : 'Für Mandant freigeben'
                            }
                            onClick={() => ops.toggleShare(d.id, !d.shared)}
                            className={`p-1.5 ${d.shared ? 'text-green-600 hover:text-green-700' : 'text-disabled hover:text-brand-700'}`}
                          >
                            {d.shared ? (
                              <Share2 className="h-4 w-4" />
                            ) : (
                              <EyeOff className="h-4 w-4" />
                            )}
                          </button>
                          <button
                            type="button"
                            title="Typ ändern"
                            onClick={() =>
                              ops.setRetag({
                                ids: [d.id],
                                title: d.title,
                                tier: d.tier,
                                typeId: d.typeId,
                              })
                            }
                            className="icon-btn"
                          >
                            <Tag className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            title="In Ordner verschieben"
                            onClick={() => setMoveDoc(d)}
                            className="icon-btn"
                          >
                            <FolderInput className="h-4 w-4" />
                          </button>
                        </>
                      )}
                      <a
                        href={`/api/staff/documents/${d.id}/download`}
                        className="text-disabled hover:text-primary p-1.5 inline-flex items-center"
                        title="Herunterladen"
                      >
                        <Download className="h-4 w-4" />
                      </a>
                      {d.deletedAt ? (
                        <button
                          type="button"
                          disabled={busy}
                          title="Wiederherstellen"
                          onClick={() => ops.restoreDoc(d.id)}
                          className="icon-btn"
                        >
                          <RotateCcw className="h-4 w-4" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          title="Löschen"
                          onClick={() => setConfirmDelDoc(d)}
                          className="text-disabled hover:text-red-600 p-1.5"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className="mt-2 text-xs text-disabled">
          {scopeLabel} · Klassifikation (GoBD/GwG) und Aufbewahrung sind unabhängig von der
          Ordnerablage. Löschen blendet nur aus — die Datei bleibt revisionssicher aufbewahrt.
        </p>
      </div>

      {confirmDelDoc && (
        <DeleteDocModal
          doc={confirmDelDoc}
          onClose={() => setConfirmDelDoc(null)}
          onDone={() => {
            setConfirmDelDoc(null);
            router.refresh();
          }}
        />
      )}
      {moveDoc && (
        <MoveDialog
          documentId={moveDoc.id}
          documentTitle={moveDoc.title}
          currentFolderId={moveDoc.folderId}
          folders={folders}
          onClose={() => setMoveDoc(null)}
          onDone={() => {
            setMoveDoc(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
