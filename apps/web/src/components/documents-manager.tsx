'use client';

import { useMemo, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import {
  Folder, FolderOpen, FolderPlus, ChevronRight, ChevronDown, Pencil, Trash2,
  Search, Download, X, FileText, FolderInput, RotateCcw, Tag, Share2, EyeOff,
} from 'lucide-react';
import { DocumentPreviewModal } from '@/components/document-preview';
import { DocumentUploadButton } from '@/components/document-upload-button';
import { MoveDialog, RetagDialog } from '@/components/document-dialogs';
import {
  softDeleteDocumentAction,
  restoreDocumentAction,
  setDocumentShareAction,
} from '@/app/staff/(protected)/documents/actions';
import {
  createFolderAction,
  renameFolderAction,
  deleteFolderAction,
} from '@/app/staff/(protected)/documents/folder-actions';
import {
  descendants,
  fmtBytes,
  fmtDate,
  type FolderNode,
} from '@/components/document-browser-utils';

export type { FolderNode };
export interface ManagedDoc {
  id: string;
  title: string;
  classification: string;
  typeName: string;
  typeId: string | null;
  tier: 'NONE' | 'GWG' | 'GOBD';
  sizeBytes: number;
  createdAt: string;
  folderId: string | null;
  deletedAt: string | null;
  shared: boolean;
}

const CLASS_LABELS: Record<string, string> = {
  GOBD_INVOICE: 'GoBD Rechnung',
  GOBD_CONTRACT: 'GoBD Vertrag',
  GOBD_TAX: 'GoBD Steuer',
  GWG_EVIDENCE: 'GwG Nachweis',
  PERSONNEL: 'Personal',
  STAFF_PRIVATE: 'Intern',
  GENERAL: 'Allgemein',
};

export function DocumentsManager({
  clientId,
  folders,
  documents,
  scopeLabel,
  canUpload = true,
}: {
  clientId: string | null;
  folders: FolderNode[];
  documents: ManagedDoc[];
  scopeLabel: string;
  canUpload?: boolean;
}) {
  const router = useRouter();
  const [sel, setSel] = useState<string | 'all' | 'none'>('all');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState('');
  const [busy, start] = useTransition();
  const [renaming, setRenaming] = useState<FolderNode | null>(null);
  const [confirmDelDoc, setConfirmDelDoc] = useState<ManagedDoc | null>(null);
  const [moveDoc, setMoveDoc] = useState<ManagedDoc | null>(null);
  const [retagDoc, setRetagDoc] = useState<ManagedDoc | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{ id: string; name: string } | null>(null);

  const active = documents.filter((d) => !d.deletedAt);
  const deleted = documents.filter((d) => d.deletedAt);
  const [showDeleted, setShowDeleted] = useState(false);

  const childrenOf = useMemo(() => {
    const m = new Map<string | null, FolderNode[]>();
    for (const f of [...folders].sort((a, b) => a.name.localeCompare(b.name, 'de'))) {
      m.set(f.parentId, [...(m.get(f.parentId) ?? []), f]);
    }
    return m;
  }, [folders]);

  const countIn = (fid: string | 'all' | 'none') => {
    if (fid === 'all') return active.length;
    if (fid === 'none') return active.filter((d) => !d.folderId).length;
    const ids = descendants(folders, fid);
    return active.filter((d) => d.folderId && ids.has(d.folderId)).length;
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
    const needle = q.trim().toLowerCase();
    if (needle) list = list.filter((d) => d.title.toLowerCase().includes(needle));
    return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [showDeleted, deleted, active, sel, folders, q]);

  function renderTree(parentId: string | null, depth: number) {
    const kids = childrenOf.get(parentId) ?? [];
    return kids.map((f) => {
      const hasKids = (childrenOf.get(f.id) ?? []).length > 0;
      const open = expanded[f.id];
      const isSel = sel === f.id;
      return (
        <div key={f.id}>
          <div
            className={`flex items-center gap-1 rounded px-2 py-1 text-sm cursor-pointer group ${
              isSel ? 'bg-brand-50 text-brand-700' : 'hover:bg-gray-50 text-secondary'
            }`}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            onClick={() => setSel(f.id)}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((x) => ({ ...x, [f.id]: !x[f.id] }));
              }}
              className={hasKids ? 'text-disabled' : 'invisible'}
            >
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
            {isSel ? <FolderOpen className="h-4 w-4 shrink-0" /> : <Folder className="h-4 w-4 shrink-0" />}
            <span className="truncate flex-1">{f.name}</span>
            <span className="text-xs text-disabled">{countIn(f.id) || ''}</span>
            <span className="hidden group-hover:flex items-center gap-0.5">
              <button
                type="button"
                title="Unterordner"
                onClick={(e) => {
                  e.stopPropagation();
                  promptCreate(f.id);
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
                  setRenaming(f);
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
                  if (
                    confirm(
                      `Ordner „${f.name}" löschen?\n\nUnterordner und Dokumente werden eine Ebene nach oben verschoben. Es wird kein Dokument gelöscht.`,
                    )
                  ) {
                    start(async () => {
                      const r = await deleteFolderAction({ folderId: f.id });
                      if (!r.ok) alert(r.error);
                      else {
                        if (sel === f.id) setSel('all');
                        router.refresh();
                      }
                    });
                  }
                }}
                className="text-disabled hover:text-red-600"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
          {open && hasKids && renderTree(f.id, depth + 1)}
        </div>
      );
    });
  }

  function promptCreate(parentId: string | null) {
    const name = window.prompt(
      parentId ? 'Name des Unterordners:' : 'Name des neuen Ordners:',
    );
    if (!name || !name.trim()) return;
    start(async () => {
      const r = await createFolderAction({ clientId, parentId, name: name.trim() });
      if (!r.ok) alert(r.error);
      else router.refresh();
    });
  }

  return (
    <div className="grid grid-cols-[240px_1fr] gap-4">
      {/* ---- Ordnerbaum ---- */}
      <div className="card p-2 self-start">
        <div className="flex items-center justify-between px-2 py-1.5 mb-1">
          <span className="text-xs font-semibold text-muted uppercase tracking-wide">
            Ordner
          </span>
          <button
            type="button"
            title="Ordner anlegen"
            onClick={() => promptCreate(null)}
            className="text-disabled hover:text-brand-700"
          >
            <FolderPlus className="h-4 w-4" />
          </button>
        </div>
        <div
          className={`flex items-center gap-1.5 rounded px-2 py-1 text-sm cursor-pointer ${
            sel === 'all' ? 'bg-brand-50 text-brand-700' : 'hover:bg-gray-50 text-secondary'
          }`}
          onClick={() => setSel('all')}
        >
          <FileText className="h-4 w-4" />
          <span className="flex-1">Alle</span>
          <span className="text-xs text-disabled">{active.length || ''}</span>
        </div>
        <div
          className={`flex items-center gap-1.5 rounded px-2 py-1 text-sm cursor-pointer ${
            sel === 'none' ? 'bg-brand-50 text-brand-700' : 'hover:bg-gray-50 text-secondary'
          }`}
          onClick={() => setSel('none')}
        >
          <Folder className="h-4 w-4 text-disabled" />
          <span className="flex-1">Ohne Ordner</span>
          <span className="text-xs text-disabled">{countIn('none') || ''}</span>
        </div>
        <div className="mt-1 border-t border-subtle pt-1">
          {folders.length === 0 ? (
            <p className="px-2 py-3 text-xs text-disabled">
              Noch keine Ordner. Oben „+" für den ersten Ordner.
            </p>
          ) : (
            renderTree(null, 0)
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
          <button
            type="button"
            onClick={() => setShowDeleted((v) => !v)}
            className={`text-xs px-3 py-1.5 rounded ${
              showDeleted ? 'bg-brand-50 text-brand-700' : 'text-muted hover:text-secondary'
            }`}
          >
            {showDeleted ? `Gelöscht (${deleted.length})` : `Gelöschte anzeigen (${deleted.length})`}
          </button>
          {canUpload && (
            <DocumentUploadButton
              clientId={clientId ?? undefined}
              folderId={typeof sel === 'string' && sel !== 'all' && sel !== 'none' ? sel : undefined}
              defaultClassification={clientId ? 'GOBD_INVOICE' : 'GENERAL'}
              buttonLabel="Hochladen"
              buttonClassName="btn-primary text-xs py-1.5"
            />
          )}
        </div>

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
                  <th className="text-left px-5 py-2.5 text-xs font-medium text-muted uppercase">Titel</th>
                  <th className="text-left px-5 py-2.5 text-xs font-medium text-muted uppercase">Klassifikation</th>
                  <th className="text-left px-5 py-2.5 text-xs font-medium text-muted uppercase">Größe</th>
                  <th className="text-left px-5 py-2.5 text-xs font-medium text-muted uppercase">Datum</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {shown.map((d) => (
                  <tr key={d.id} className="hover:bg-gray-50">
                    <td className="px-5 py-3 font-medium text-primary">
                      <button
                        type="button"
                        onClick={() => setPreviewDoc({ id: d.id, name: d.title })}
                        className="text-left hover:underline"
                        title="Vorschau öffnen"
                      >
                        {d.title}
                      </button>
                    </td>
                    <td className="px-5 py-3 text-secondary">
                      <span className="inline-flex items-center gap-1.5">
                        {d.typeName || CLASS_LABELS[d.classification] || d.classification}
                        {!d.deletedAt && (
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded border inline-flex items-center gap-0.5 ${
                              d.shared
                                ? 'bg-green-50 text-green-700 border-green-200'
                                : 'bg-gray-50 text-muted border-default'
                            }`}
                          >
                            {d.shared ? <Share2 className="h-2.5 w-2.5" /> : <EyeOff className="h-2.5 w-2.5" />}
                            {d.shared ? 'geteilt' : 'privat'}
                          </span>
                        )}
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
                            title={d.shared ? 'Freigabe für Mandant zurückziehen' : 'Für Mandant freigeben'}
                            onClick={() =>
                              start(async () => {
                                const r = await setDocumentShareAction({ documentId: d.id, share: !d.shared });
                                if (!r.ok) alert(r.error); else router.refresh();
                              })
                            }
                            className={`p-1.5 ${d.shared ? 'text-green-600 hover:text-green-700' : 'text-disabled hover:text-brand-700'}`}
                          >
                            {d.shared ? <Share2 className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                          </button>
                          <button
                            type="button"
                            title="Typ ändern"
                            onClick={() => setRetagDoc(d)}
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
                          onClick={() =>
                            start(async () => {
                              const r = await restoreDocumentAction({ documentId: d.id });
                              if (!r.ok) alert(r.error);
                              else router.refresh();
                            })
                          }
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
          {scopeLabel} · Klassifikation (GoBD/GwG) und Aufbewahrung sind
          unabhängig von der Ordnerablage. Löschen blendet nur aus — die Datei
          bleibt revisionssicher aufbewahrt.
        </p>
      </div>

      {renaming && (
        <RenameModal
          folder={renaming}
          onClose={() => setRenaming(null)}
          onDone={() => {
            setRenaming(null);
            router.refresh();
          }}
        />
      )}
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
      {retagDoc && (
        <RetagDialog
          documentId={retagDoc.id}
          documentTitle={retagDoc.title}
          currentTier={retagDoc.tier}
          currentTypeId={retagDoc.typeId}
          onClose={() => setRetagDoc(null)}
          onDone={() => {
            setRetagDoc(null);
            router.refresh();
          }}
        />
      )}
      {previewDoc && (
        <DocumentPreviewModal
          documentId={previewDoc.id}
          documentTitle={previewDoc.name}
          onClose={() => setPreviewDoc(null)}
        />
      )}
    </div>
  );
}

function RenameModal({
  folder,
  onClose,
  onDone,
}: {
  folder: FolderNode;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(folder.name);
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const modal = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-sm card p-6 relative" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={onClose} className="modal-close">
          <X className="h-5 w-5" />
        </button>
        <h2 className="text-base font-semibold text-primary mb-3">Ordner umbenennen</h2>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="input mb-3"
          maxLength={120}
        />
        {err && <div className="rounded bg-red-50 p-2 text-xs text-red-700 mb-3">{err}</div>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="btn-secondary flex-1">
            Abbrechen
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              start(async () => {
                setErr(null);
                const r = await renameFolderAction({ folderId: folder.id, name: name.trim() });
                if (r.ok) onDone();
                else setErr(r.error ?? 'Fehler.');
              })
            }
            className="btn-primary flex-1"
          >
            {busy ? 'Speichert…' : 'Speichern'}
          </button>
        </div>
      </div>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(modal, document.body) : null;
}

function DeleteDocModal({
  doc,
  onClose,
  onDone,
}: {
  doc: ManagedDoc;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const locked = doc.classification.startsWith('GOBD_') || doc.classification === 'GWG_EVIDENCE';
  const modal = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-md card p-6 relative" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={onClose} className="modal-close">
          <X className="h-5 w-5" />
        </button>
        <h2 className="text-lg font-semibold text-primary mb-2">Dokument löschen</h2>
        <p className="text-sm text-secondary mb-3">„{doc.title}" wird aus den Listen ausgeblendet.</p>
        <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800 mb-4">
          Die Datei bleibt im revisionssicheren Object-Store und wird
          <strong> gesetzlich weiter aufbewahrt</strong>
          {locked
            ? ' (Object-Lock COMPLIANCE — physisch nicht löschbar bis Fristende, § 147 AO / § 8 Abs. 4 GwG).'
            : ' — sie wird nicht physisch entfernt.'}{' '}
          Protokolliert im Audit-Log, wiederherstellbar.
        </div>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          maxLength={500}
          className="input mb-3"
          placeholder="Grund (optional)"
        />
        {err && <div className="rounded bg-red-50 p-2 text-xs text-red-700 mb-3">{err}</div>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="btn-secondary flex-1">
            Abbrechen
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              start(async () => {
                setErr(null);
                const r = await softDeleteDocumentAction({
                  documentId: doc.id,
                  reason: reason.trim() || undefined,
                });
                if (r.ok) onDone();
                else setErr(r.error ?? 'Fehler.');
              })
            }
            className="btn-primary flex-1 !bg-red-600 hover:!bg-red-700"
          >
            {busy ? 'Löscht…' : 'Löschen'}
          </button>
        </div>
      </div>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(modal, document.body) : null;
}
