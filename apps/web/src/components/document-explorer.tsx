'use client';

// =============================================================================
// DocumentExplorer — DIE Dokumentenverwaltung (konsolidiert aus den früheren
// Komponenten DocumentBrowser + DocumentsManager, die dieselben Server-Actions
// doppelt verdrahteten).
//
// Zwei Varianten, ein Satz Handler/Dialoge:
//   variant="browser"  — /staff/documents: URL-getrieben (Server filtert per
//                        ?type=&client=&folder=&q=&deleted=), Breadcrumbs,
//                        Multi-Select/Bulk, Drag&Drop, Kontextmenü, OS-Drop.
//   variant="embedded" — Mandanten-Tab „Dokumente" + Subsumtions-„Aktenregal":
//                        alle Dokumente auf einmal, Sidebar-Ordnerbaum filtert
//                        lokal, Tabelle, Lösch-Dialog mit Grund-Feld.
//
// Geteilt: useDocumentOps (Transition, Fehlerbanner, Share/Restore) +
// SharedDialogs (Preview, Retag, Ordner anlegen/umbenennen, Confirm).
// =============================================================================

import { useMemo, useState, useTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Folder, FileText, ChevronRight, Search, FolderPlus,
  Download, RotateCcw, Trash2, Pencil, FolderInput, Tag, X, CornerLeftUp,
  Share2, EyeOff,
} from 'lucide-react';
import { DocumentPreviewModal } from '@/components/document-preview';
import { DocumentUploadButton } from '@/components/document-upload-button';
import {
  DeleteDocModal,
  MoveDialog,
  MoveTargetDialog,
  RetagDialog,
} from '@/components/document-dialogs';
import { ConfirmModal, InputModal } from '@/components/ui/modal';
import { FolderTreePicker } from '@/components/folder-tree-picker';
import {
  softDeleteDocumentAction,
  restoreDocumentAction,
  setDocumentShareAction,
} from '@/app/staff/(protected)/documents/actions';
import {
  createFolderAction,
  renameFolderAction,
  deleteFolderAction,
  moveFolderAction,
  setDocumentFolderAction,
} from '@/app/staff/(protected)/documents/folder-actions';
import {
  TIER_BADGE,
  descendants,
  fileIcon,
  fmtBytes,
  fmtDate,
  navIcon,
  runChunked,
  type Crumb,
  type Entry,
  type FolderNode,
} from '@/components/document-browser-utils';

export type { Crumb, Entry, FolderNode };

/** Dokument-Zeile für den Embedded-Modus (siehe toManagedDoc in managed-docs). */
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

// ---------------------------------------------------------------------------
// Geteilter Zustand + Handler beider Varianten
// ---------------------------------------------------------------------------

interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  busyLabel?: string;
  danger?: boolean;
  action: () => Promise<{ ok: boolean; error?: string }>;
}
interface RetagState {
  ids: string[];
  title: string;
  /** Nur bei Einzel-Dokument — sperrt Herabstufungen clientseitig. */
  tier?: 'NONE' | 'GWG' | 'GOBD';
  typeId?: string | null;
  onDone?: () => void;
}
interface CreateFolderState { parentId: string | null; title: string; placeholder: string }

function useDocumentOps() {
  const router = useRouter();
  const [busy, start] = useTransition();
  // Sammel-Fehlermeldung für Hintergrund-Operationen (statt window.alert).
  const [opError, setOpError] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{ id: string; name: string } | null>(null);
  const [retag, setRetag] = useState<RetagState | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [createFolder, setCreateFolder] = useState<CreateFolderState | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  function toggleShare(id: string, share: boolean) {
    start(async () => {
      setOpError(null);
      const r = await setDocumentShareAction({ documentId: id, share });
      if (!r.ok) setOpError(r.error ?? 'Fehler.'); else router.refresh();
    });
  }
  function restoreDoc(id: string) {
    start(async () => {
      setOpError(null);
      const r = await restoreDocumentAction({ documentId: id });
      if (!r.ok) setOpError(r.error ?? 'Fehler.'); else router.refresh();
    });
  }

  return {
    router, busy, start,
    opError, setOpError,
    previewDoc, setPreviewDoc,
    retag, setRetag,
    renameTarget, setRenameTarget,
    createFolder, setCreateFolder,
    confirmState, setConfirmState,
    toggleShare, restoreDoc,
  };
}
type DocumentOps = ReturnType<typeof useDocumentOps>;

function OpErrorBanner({ ops }: { ops: DocumentOps }) {
  if (!ops.opError) return null;
  return (
    <div className="alert-error-sm mb-3 flex items-start justify-between gap-3">
      <span className="whitespace-pre-line">{ops.opError}</span>
      <button
        type="button"
        onClick={() => ops.setOpError(null)}
        aria-label="Meldung schließen"
        className="shrink-0 opacity-70 hover:opacity-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** Badge „geteilt"/„privat" an Mandanten-Dokumenten. */
function ShareBadge({ shared }: { shared: boolean }) {
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded border inline-flex items-center gap-0.5 ${
        shared
          ? 'bg-green-50 text-green-700 border-green-200'
          : 'bg-gray-50 text-muted border-default'
      }`}
    >
      {shared ? <Share2 className="h-2.5 w-2.5" /> : <EyeOff className="h-2.5 w-2.5" />}
      {shared ? 'geteilt' : 'privat'}
    </span>
  );
}

/** Von beiden Varianten genutzte Dialoge (Zustand in useDocumentOps). */
function SharedDialogs({ ops, scopeClientId }: { ops: DocumentOps; scopeClientId: string | null }) {
  const { router } = ops;
  return (
    <>
      {ops.retag && (
        <RetagDialog
          documentIds={ops.retag.ids}
          documentTitle={ops.retag.title}
          currentTier={ops.retag.tier}
          currentTypeId={ops.retag.typeId}
          onClose={() => ops.setRetag(null)}
          onDone={() => {
            const cb = ops.retag?.onDone;
            ops.setRetag(null);
            cb?.();
            router.refresh();
          }}
        />
      )}
      {ops.previewDoc && (
        <DocumentPreviewModal
          documentId={ops.previewDoc.id}
          documentTitle={ops.previewDoc.name}
          onClose={() => ops.setPreviewDoc(null)}
        />
      )}
      {ops.createFolder && (
        <InputModal
          title={ops.createFolder.title}
          placeholder={ops.createFolder.placeholder}
          confirmLabel="Anlegen"
          busyLabel="Legt an…"
          onSubmit={async (name) => {
            const r = await createFolderAction({
              clientId: scopeClientId, parentId: ops.createFolder!.parentId, name,
            });
            if (r.ok) router.refresh();
            return r;
          }}
          onClose={() => ops.setCreateFolder(null)}
        />
      )}
      {ops.renameTarget && (
        <InputModal
          title="Ordner umbenennen"
          initialValue={ops.renameTarget.name}
          onSubmit={async (name) => {
            const r = await renameFolderAction({ folderId: ops.renameTarget!.id, name });
            if (r.ok) router.refresh();
            return r;
          }}
          onClose={() => ops.setRenameTarget(null)}
        />
      )}
      {ops.confirmState && (
        <ConfirmModal
          title={ops.confirmState.title}
          message={ops.confirmState.message}
          confirmLabel={ops.confirmState.confirmLabel}
          busyLabel={ops.confirmState.busyLabel}
          danger={ops.confirmState.danger}
          onConfirm={ops.confirmState.action}
          onClose={() => ops.setConfirmState(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Öffentliche Komponente
// ---------------------------------------------------------------------------

interface BrowserProps {
  variant: 'browser';
  crumbs: Crumb[];
  entries: Entry[];
  scope: { clientId: string | null; typeParam: string } | null;
  folders: FolderNode[];
  currentFolderId: string | null;
  deleted: boolean;
  q: string;
  toggleDeletedHref?: string;
}
interface EmbeddedProps {
  variant: 'embedded';
  clientId: string | null;
  folders: FolderNode[];
  documents: ManagedDoc[];
  scopeLabel: string;
  canUpload?: boolean;
  /** Sachverhalts-Bezug — Uploads aus dem Aktenregal-Tab setzen analysis_id. */
  analysisId?: string;
}

export function DocumentExplorer(props: BrowserProps | EmbeddedProps) {
  const ops = useDocumentOps();
  const scopeClientId =
    props.variant === 'browser' ? (props.scope?.clientId ?? null) : props.clientId;
  return (
    <>
      {props.variant === 'browser'
        ? <BrowserView {...props} ops={ops} />
        : <EmbeddedView {...props} ops={ops} />}
      <SharedDialogs ops={ops} scopeClientId={scopeClientId} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Variante „browser" — /staff/documents (URL-getrieben, Explorer-Stil)
// ---------------------------------------------------------------------------

type Sel = { kind: 'file' | 'folder'; id: string };

function BrowserView({
  crumbs, entries, scope, folders, currentFolderId, deleted, q, toggleDeletedHref, ops,
}: Omit<BrowserProps, 'variant'> & { ops: DocumentOps }) {
  const { router, busy, start } = ops;
  const [search, setSearch] = useState(q);
  const [sel, setSel] = useState<Sel[]>([]);
  const [moveOpen, setMoveOpen] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number; e: Entry } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | 'root' | null>(null);
  const [osDrag, setOsDrag] = useState(false);

  useEffect(() => {
    const close = () => setCtx(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, []);

  const here = crumbs[crumbs.length - 1]?.href ?? '/staff/documents';
  const selKey = (s: Sel) => `${s.kind}:${s.id}`;
  const selected = useMemo(() => new Set(sel.map(selKey)), [sel]);
  const isSel = (kind: 'file' | 'folder', id: string) => selected.has(`${kind}:${id}`);

  function toggle(kind: 'file' | 'folder', id: string, additive: boolean) {
    setSel((prev) => {
      const has = prev.some((s) => s.kind === kind && s.id === id);
      if (additive) {
        return has ? prev.filter((s) => !(s.kind === kind && s.id === id)) : [...prev, { kind, id }];
      }
      return has && prev.length === 1 ? [] : [{ kind, id }];
    });
  }
  const clearSel = () => setSel([]);

  function applySearch(ev: React.FormEvent) {
    ev.preventDefault();
    const u = new URL(here, window.location.origin);
    if (search.trim()) u.searchParams.set('q', search.trim());
    else u.searchParams.delete('q');
    router.push(u.pathname + u.search);
  }
  function newFolder() {
    if (!scope) return;
    ops.setCreateFolder({
      parentId: currentFolderId,
      title: 'Neuer Ordner',
      placeholder: 'Name des neuen Ordners',
    });
  }

  // ---- Verschieben (eine Menge → Ziel-Ordner-ID | null=Wurzel) ----
  // Begrenzt parallel (Chunks), Fehler gesammelt anzeigen.
  function moveSet(items: Sel[], target: string | null) {
    if (items.length === 0) return;
    start(async () => {
      ops.setOpError(null);
      const errs = await runChunked(items, async (it) => {
        if (it.kind === 'file') {
          const r = await setDocumentFolderAction({ documentId: it.id, folderId: target });
          return r.ok ? null : (r.error ?? 'Fehler');
        }
        // Ordner nicht in sich/Teilbaum
        if (target && descendants(folders, it.id).has(target)) {
          return 'Ordner kann nicht in seinen eigenen Unterbaum.';
        }
        const r = await moveFolderAction({ folderId: it.id, newParentId: target });
        return r.ok ? null : (r.error ?? 'Fehler');
      });
      if (errs.length) ops.setOpError([...new Set(errs)].join('\n'));
      clearSel();
      setMoveOpen(false);
      router.refresh();
    });
  }

  // Drag-Payload: gezogenes Element + ggf. ganze Auswahl
  function dragPayload(e: Entry): Sel[] {
    if (e.kind === 'nav') return [];
    const me: Sel = { kind: e.kind, id: e.id };
    return isSel(me.kind, me.id) && sel.length > 0 ? sel : [me];
  }
  function onDropInto(target: string | null, payloadRaw: string) {
    try {
      const items = JSON.parse(payloadRaw) as Sel[];
      moveSet(items.filter((i) => !(i.kind === 'folder' && i.id === target)), target);
    } catch { /* ignore */ }
  }

  function softDelete(id: string, name: string) {
    ops.setConfirmState({
      title: 'Dokument löschen',
      message: `„${name}" löschen?\nDie Datei bleibt revisionssicher aufbewahrt (Object-Lock), wird nur ausgeblendet.`,
      confirmLabel: 'Löschen',
      busyLabel: 'Löscht…',
      danger: true,
      action: async () => {
        const r = await softDeleteDocumentAction({ documentId: id });
        if (r.ok) router.refresh();
        return r;
      },
    });
  }
  // Bulk-Freigabe/-Entzug: begrenzt parallel, Fehler gesammelt anzeigen.
  function bulkShare(share: boolean) {
    const ids = sel.filter((s) => s.kind === 'file').map((s) => s.id);
    start(async () => {
      ops.setOpError(null);
      const errs = await runChunked(ids, async (id) => {
        const r = await setDocumentShareAction({ documentId: id, share });
        return r.ok ? null : (r.error ?? 'Fehler');
      });
      if (errs.length) ops.setOpError([...new Set(errs)].join('\n'));
      clearSel();
      router.refresh();
    });
  }
  function deleteFolder(id: string, name: string) {
    ops.setConfirmState({
      title: 'Ordner löschen',
      message: `Ordner „${name}" löschen?\nInhalt rückt eine Ebene hoch. Kein Dokument wird gelöscht.`,
      confirmLabel: 'Löschen',
      busyLabel: 'Löscht…',
      danger: true,
      action: async () => {
        const r = await deleteFolderAction({ folderId: id });
        if (r.ok) router.refresh();
        return r;
      },
    });
  }
  function dlUrl(fileIds: string[], folderIds: string[]) {
    const p = new URLSearchParams();
    if (fileIds.length) p.set('ids', fileIds.join(','));
    if (folderIds.length) p.set('folders', folderIds.join(','));
    return `/api/staff/documents/download?${p.toString()}`;
  }

  // OS-Datei-Drop = Upload in den aktuellen Bereich/Ordner. Nur sinnvoll,
  // wenn ein Scope (Mandant/Kanzlei-intern) offen ist und nicht im
  // Gelöscht-Modus. Typ = Default-Typ der Kanzlei (GENERAL/erste NONE).
  async function uploadDropped(files: File[]) {
    if (!scope || deleted || files.length === 0) return;
    let typeId = '';
    try {
      const r = await fetch('/api/staff/document-types');
      if (r.ok) {
        const d = (await r.json()) as {
          types: { id: string; classificationKey: string | null; tier: string }[];
        };
        typeId =
          d.types.find((t) => t.classificationKey === 'GENERAL')?.id ??
          d.types.find((t) => t.tier === 'NONE')?.id ??
          d.types[0]?.id ?? '';
      }
    } catch { /* ignore */ }
    if (!typeId) { ops.setOpError('Kein Datei-Typ verfügbar.'); return; }
    start(async () => {
      ops.setOpError(null);
      const errs: string[] = [];
      for (const f of files) {
        const fd = new FormData();
        fd.set('file', f);
        fd.set('documentTypeId', typeId);
        fd.set('title', f.name.replace(/\.[^.]+$/, ''));
        fd.set('mimeType', f.type || 'application/octet-stream');
        if (scope.clientId) fd.set('clientId', scope.clientId);
        if (currentFolderId) fd.set('folderId', currentFolderId);
        const res = await fetch('/api/staff/documents/commit', { method: 'POST', body: fd });
        if (!res.ok) {
          const b = await res.json().catch(() => ({}));
          errs.push(`${f.name}: ${(b as { error?: string }).error ?? res.status}`);
        }
      }
      if (errs.length) ops.setOpError(`Upload-Fehler:\n${errs.join('\n')}`);
      router.refresh();
    });
  }
  // Unterscheidet OS-Datei-Drop (dataTransfer.types enthält 'Files') vom
  // internen Verschieben (text/plain mit unserer Payload).
  const isOsFileDrag = (dt: DataTransfer) =>
    Array.from(dt.types).includes('Files');

  return (
    <div
      className="p-8 relative"
      onContextMenu={(e) => { if (ctx) e.preventDefault(); }}
      onDragOver={(e) => {
        if (scope && !deleted && isOsFileDrag(e.dataTransfer)) {
          e.preventDefault();
          setOsDrag(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setOsDrag(false);
      }}
      onDrop={(e) => {
        if (scope && !deleted && isOsFileDrag(e.dataTransfer)) {
          e.preventDefault();
          setOsDrag(false);
          uploadDropped(Array.from(e.dataTransfer.files));
        }
      }}
    >
      {osDrag && scope && !deleted && (
        <div className="absolute inset-4 z-[90] rounded-xl border-2 border-dashed border-brand-400 bg-brand-50/80 flex items-center justify-center pointer-events-none">
          <p className="text-sm font-medium text-brand-700">
            Dateien hier ablegen — Upload in „{crumbs[crumbs.length - 1]?.label}"
          </p>
        </div>
      )}
      {/* Breadcrumb (Ordner-Crumbs sind Drop-Ziele) */}
      <nav className="flex items-center flex-wrap gap-1 text-sm text-muted mb-4">
        {crumbs.map((c, i) => (
          <span key={c.href} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-disabled" />}
            {i === crumbs.length - 1 ? (
              <span className="font-semibold text-primary">{c.label}</span>
            ) : (
              <Link href={c.href} className="hover:text-brand-700 hover:underline">{c.label}</Link>
            )}
          </span>
        ))}
      </nav>

      {/* Toolbar / Auswahl-Leiste */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        {sel.length > 0 ? (
          <>
            <span className="text-sm font-medium text-secondary">{sel.length} ausgewählt</span>
            <button type="button" onClick={() => setMoveOpen(true)} disabled={busy} className="btn-secondary text-xs py-1.5">
              <FolderInput className="h-4 w-4" /> Verschieben
            </button>
            <button
              type="button"
              onClick={() => {
                const fileIds = sel.filter((s) => s.kind === 'file').map((s) => s.id);
                const folderIds = sel.filter((s) => s.kind === 'folder').map((s) => s.id);
                window.location.href = dlUrl(fileIds, folderIds);
              }}
              className="btn-secondary text-xs py-1.5"
            >
              <Download className="h-4 w-4" />
              {sel.length > 1 || sel.some((s) => s.kind === 'folder') ? 'Als ZIP laden' : 'Herunterladen'}
            </button>
            {sel.every((s) => s.kind === 'file') && !deleted && (
              <button
                type="button"
                onClick={() => {
                  const ids = sel.filter((s) => s.kind === 'file').map((s) => s.id);
                  ops.setRetag({ ids, title: `${ids.length} Dokument(e)`, onDone: clearSel });
                }}
                disabled={busy}
                className="btn-secondary text-xs py-1.5"
              >
                <Tag className="h-4 w-4" /> Typ ändern
              </button>
            )}
            {scope?.clientId && sel.every((s) => s.kind === 'file') && !deleted && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => bulkShare(true)}
                  className="btn-secondary text-xs py-1.5 !text-green-700"
                >
                  <Share2 className="h-4 w-4" /> Freigeben
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => bulkShare(false)}
                  className="btn-secondary text-xs py-1.5"
                >
                  <EyeOff className="h-4 w-4" /> Privat
                </button>
              </>
            )}
            {sel.every((s) => s.kind === 'file') && !deleted && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const ids = sel.filter((s) => s.kind === 'file').map((s) => s.id);
                  ops.setConfirmState({
                    title: 'Dokumente löschen',
                    message: `${ids.length} Dokument(e) löschen? Bleiben revisionssicher aufbewahrt, nur ausgeblendet.`,
                    confirmLabel: 'Löschen',
                    busyLabel: 'Löscht…',
                    danger: true,
                    action: async () => {
                      const errs = await runChunked(ids, async (id) => {
                        const r = await softDeleteDocumentAction({ documentId: id });
                        return r.ok ? null : (r.error ?? 'Fehler');
                      });
                      clearSel();
                      router.refresh();
                      return errs.length
                        ? { ok: false, error: [...new Set(errs)].join('\n') }
                        : { ok: true };
                    },
                  });
                }}
                className="btn-secondary text-xs py-1.5 !text-red-600"
              >
                <Trash2 className="h-4 w-4" /> Löschen
              </button>
            )}
            <button type="button" onClick={clearSel} className="text-xs text-muted hover:text-secondary">
              Aufheben
            </button>
          </>
        ) : (
          <>
            <form onSubmit={applySearch} className="relative flex-1 min-w-[220px]">
              <Search className="h-4 w-4 text-disabled absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="In diesem Ordner suchen…"
                className="input pl-9"
              />
            </form>
            {scope && (
              <>
                {toggleDeletedHref && (
                  <Link
                    href={toggleDeletedHref}
                    className={`text-xs px-3 py-1.5 rounded ${deleted ? 'bg-brand-50 text-brand-700' : 'text-muted hover:text-secondary'}`}
                  >
                    {deleted ? 'Gelöschte (an)' : 'Gelöschte zeigen'}
                  </Link>
                )}
                <button type="button" onClick={newFolder} disabled={busy} className="btn-secondary text-xs py-1.5">
                  <FolderPlus className="h-4 w-4" /> Neuer Ordner
                </button>
                {!deleted && (
                  <DocumentUploadButton
                    clientId={scope.clientId ?? undefined}
                    folderId={currentFolderId ?? undefined}
                    buttonLabel="Hochladen"
                    buttonClassName="btn-primary text-xs py-1.5"
                  />
                )}
              </>
            )}
          </>
        )}
      </div>

      <OpErrorBanner ops={ops} />

      {/* „Eine Ebene hoch" als Drop-Ziel (Wurzel des Scopes) */}
      {scope && currentFolderId && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDropTarget('root'); }}
          onDragLeave={() => setDropTarget(null)}
          onDrop={(e) => { setDropTarget(null); onDropInto(null, e.dataTransfer.getData('text/plain')); }}
          className={`mb-2 flex items-center gap-2 rounded-md border border-dashed px-3 py-1.5 text-xs ${
            dropTarget === 'root' ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-default text-disabled'
          }`}
        >
          <CornerLeftUp className="h-3.5 w-3.5" />
          Hierher ziehen = aus Ordner herauslösen (Wurzel)
        </div>
      )}

      {/* Liste */}
      {entries.length === 0 ? (
        <div className="card px-6 py-16 text-center">
          <Folder className="h-12 w-12 text-disabled mx-auto mb-3" />
          <p className="text-sm text-disabled">{deleted ? 'Keine gelöschten Dokumente hier.' : 'Dieser Ordner ist leer.'}</p>
        </div>
      ) : (
        <div className="card overflow-hidden divide-y divide-border-subtle">
          {entries.map((e) => {
            const sk = e.kind !== 'nav';
            const selectedRow = sk && isSel(e.kind as 'file' | 'folder', e.id);
            const isDrop = e.kind === 'folder' && dropTarget === e.id;
            const Icon =
              e.kind === 'file' ? fileIcon(e.mimeType)
              : e.kind === 'folder' ? Folder : navIcon(e.icon);
            return (
              <div
                key={`${e.kind}-${e.id}`}
                draggable={sk}
                onDragStart={(ev) => {
                  const p = dragPayload(e);
                  ev.dataTransfer.setData('text/plain', JSON.stringify(p));
                  ev.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={
                  e.kind === 'folder'
                    ? (ev) => { ev.preventDefault(); setDropTarget(e.id); }
                    : undefined
                }
                onDragLeave={e.kind === 'folder' ? () => setDropTarget(null) : undefined}
                onDrop={
                  e.kind === 'folder'
                    ? (ev) => { ev.preventDefault(); setDropTarget(null); onDropInto(e.id, ev.dataTransfer.getData('text/plain')); }
                    : undefined
                }
                onContextMenu={(ev) => {
                  if (e.kind === 'nav') return;
                  ev.preventDefault();
                  if (sk && !isSel(e.kind as 'file' | 'folder', e.id)) toggle(e.kind as 'file' | 'folder', e.id, false);
                  setCtx({ x: ev.clientX, y: ev.clientY, e });
                }}
                className={`flex items-center gap-3 px-5 py-3 group ${
                  isDrop ? 'bg-brand-50 ring-1 ring-inset ring-brand-300'
                  : selectedRow ? 'bg-brand-50/60' : 'hover:bg-gray-50'
                }`}
              >
                {sk && (
                  <input
                    type="checkbox"
                    checked={selectedRow}
                    onChange={() => toggle(e.kind as 'file' | 'folder', e.id, true)}
                    className="shrink-0"
                    aria-label="Auswählen"
                  />
                )}
                {e.kind === 'nav' || e.kind === 'folder' ? (
                  <Link href={e.href} className="flex items-center gap-3 flex-1 min-w-0">
                    <Icon className="h-5 w-5 text-brand-600 shrink-0" />
                    <span className="font-medium text-primary truncate">{e.name}</span>
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => ops.setPreviewDoc({ id: e.id, name: e.name })}
                    className="flex items-center gap-3 flex-1 min-w-0 text-left"
                    title="Vorschau öffnen"
                  >
                    <Icon className="h-5 w-5 text-disabled shrink-0" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-primary truncate hover:underline">{e.name}</span>
                        {e.tier !== 'NONE' && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                            e.tier === 'GOBD' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-amber-50 text-amber-700 border-amber-200'
                          }`}>
                            {TIER_BADGE[e.tier]}
                          </span>
                        )}
                        {scope?.clientId && !e.deletedAt && <ShareBadge shared={e.shared} />}
                      </div>
                      <div className="text-xs text-disabled truncate">
                        {e.typeName || '—'} · {fmtBytes(e.sizeBytes)} ·{' '}
                        {e.deletedAt ? `gelöscht ${fmtDate(e.deletedAt)}` : fmtDate(e.createdAt)}
                      </div>
                    </div>
                  </button>
                )}
                {e.kind === 'file' && (
                  <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100">
                    <a href={`/api/staff/documents/${e.id}/download`} className="text-disabled hover:text-primary p-1.5 inline-flex items-center" title="Herunterladen">
                      <Download className="h-4 w-4" />
                    </a>
                    {e.deletedAt ? (
                      <button type="button" disabled={busy} title="Wiederherstellen" onClick={() => ops.restoreDoc(e.id)} className="icon-btn">
                        <RotateCcw className="h-4 w-4" />
                      </button>
                    ) : (
                      <>
                        {scope?.clientId && (
                          <button
                            type="button"
                            disabled={busy}
                            title={e.shared ? 'Freigabe für Mandant zurückziehen' : 'Für Mandant freigeben'}
                            onClick={() => ops.toggleShare(e.id, !e.shared)}
                            className={`p-1.5 ${e.shared ? 'text-green-600 hover:text-green-700' : 'text-disabled hover:text-brand-700'}`}
                          >
                            {e.shared ? <Share2 className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                          </button>
                        )}
                        <button type="button" title="Typ ändern" onClick={() => ops.setRetag({ ids: [e.id], title: e.name, tier: e.tier, typeId: e.typeId })} className="icon-btn">
                          <Tag className="h-4 w-4" />
                        </button>
                        <button type="button" title="Verschieben" onClick={() => { toggle('file', e.id, false); setMoveOpen(true); }} className="icon-btn">
                          <FolderInput className="h-4 w-4" />
                        </button>
                        <button type="button" title="Löschen" disabled={busy} onClick={() => softDelete(e.id, e.name)} className="text-disabled hover:text-red-600 p-1.5">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </div>
                )}
                {e.kind === 'folder' && (
                  <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100">
                    <a
                      href={dlUrl([], [e.id])}
                      className="text-disabled hover:text-primary p-1.5 inline-flex items-center"
                      title="Ordner als ZIP herunterladen"
                    >
                      <Download className="h-4 w-4" />
                    </a>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Rechtsklick-Menü */}
      {ctx && (
        <div
          className="fixed z-[120] w-48 card py-1 text-sm shadow-lg"
          style={{ top: ctx.y, left: ctx.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctx.e.kind === 'folder' && (
            <>
              <MenuItem icon={Folder} label="Öffnen" onClick={() => router.push((ctx.e as { href: string }).href)} />
              <MenuItem icon={Download} label="Als ZIP laden" onClick={() => { window.location.href = dlUrl([], [ctx.e.id]); setCtx(null); }} />
              <MenuItem icon={Pencil} label="Umbenennen" onClick={() => { ops.setRenameTarget({ id: ctx.e.id, name: ctx.e.name }); setCtx(null); }} />
              <MenuItem icon={FolderInput} label="Verschieben" onClick={() => { setMoveOpen(true); setCtx(null); }} />
              <MenuItem icon={Trash2} label="Löschen" danger onClick={() => { deleteFolder(ctx.e.id, ctx.e.name); setCtx(null); }} />
            </>
          )}
          {ctx.e.kind === 'file' && (
            <>
              <MenuItem icon={FileText} label="Details" onClick={() => router.push(`/staff/documents/${ctx.e.id}`)} />
              <MenuItem icon={Download} label="Herunterladen" onClick={() => { window.location.href = `/api/staff/documents/${ctx.e.id}/download`; setCtx(null); }} />
              {!('deletedAt' in ctx.e && ctx.e.deletedAt) && (
                <>
                  <MenuItem icon={FolderInput} label="Verschieben" onClick={() => { setMoveOpen(true); setCtx(null); }} />
                  <MenuItem icon={Tag} label="Typ ändern" onClick={() => { const f = ctx.e as Extract<Entry, { kind: 'file' }>; ops.setRetag({ ids: [f.id], title: f.name, tier: f.tier, typeId: f.typeId }); setCtx(null); }} />
                  <MenuItem icon={Trash2} label="Löschen" danger onClick={() => { softDelete(ctx.e.id, ctx.e.name); setCtx(null); }} />
                </>
              )}
              {'deletedAt' in ctx.e && ctx.e.deletedAt && (
                <MenuItem icon={RotateCcw} label="Wiederherstellen" onClick={() => { ops.restoreDoc(ctx.e.id); setCtx(null); }} />
              )}
            </>
          )}
        </div>
      )}

      {moveOpen && (
        <MoveTargetDialog
          folders={folders}
          movingFolderIds={sel.filter((s) => s.kind === 'folder').map((s) => s.id)}
          onClose={() => setMoveOpen(false)}
          onPick={(target) => moveSet(sel, target)}
        />
      )}
    </div>
  );
}

function MenuItem({
  icon: Icon, label, onClick, danger,
}: { icon: typeof Folder; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 hover:bg-gray-50 ${danger ? 'text-red-600 hover:bg-red-50' : 'text-secondary'}`}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Variante „embedded" — Mandanten-Tab + Aktenregal (lokal gefiltert, Tabelle)
// ---------------------------------------------------------------------------

function EmbeddedView({
  clientId, folders, documents, scopeLabel, canUpload = true, analysisId, ops,
}: Omit<EmbeddedProps, 'variant'> & { ops: DocumentOps }) {
  const { router, busy } = ops;
  const [sel, setSel] = useState<string | 'all' | 'none'>('all');
  const [q, setQ] = useState('');
  const [moveDoc, setMoveDoc] = useState<ManagedDoc | null>(null);
  const [confirmDelDoc, setConfirmDelDoc] = useState<ManagedDoc | null>(null);

  const active = documents.filter((d) => !d.deletedAt);
  const deleted = documents.filter((d) => d.deletedAt);
  const [showDeleted, setShowDeleted] = useState(false);

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
          <span className="text-xs font-semibold text-muted uppercase tracking-wide">
            Ordner
          </span>
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
          <span className="text-xs text-disabled">{active.length || ''}</span>
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
              onSelect={(id) => { if (id) setSel(id); }}
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
              analysisId={analysisId}
              defaultClassification={clientId ? 'GOBD_INVOICE' : 'GENERAL'}
              buttonLabel="Hochladen"
              buttonClassName="btn-primary text-xs py-1.5"
            />
          )}
        </div>

        <OpErrorBanner ops={ops} />

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
                        onClick={() => ops.setPreviewDoc({ id: d.id, name: d.title })}
                        className="text-left hover:underline"
                        title="Vorschau öffnen"
                      >
                        {d.title}
                      </button>
                    </td>
                    <td className="px-5 py-3 text-secondary">
                      <span className="inline-flex items-center gap-1.5">
                        {d.typeName || CLASS_LABELS[d.classification] || d.classification}
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
                            title={d.shared ? 'Freigabe für Mandant zurückziehen' : 'Für Mandant freigeben'}
                            onClick={() => ops.toggleShare(d.id, !d.shared)}
                            className={`p-1.5 ${d.shared ? 'text-green-600 hover:text-green-700' : 'text-disabled hover:text-brand-700'}`}
                          >
                            {d.shared ? <Share2 className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                          </button>
                          <button
                            type="button"
                            title="Typ ändern"
                            onClick={() => ops.setRetag({ ids: [d.id], title: d.title, tier: d.tier, typeId: d.typeId })}
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
          {scopeLabel} · Klassifikation (GoBD/GwG) und Aufbewahrung sind
          unabhängig von der Ordnerablage. Löschen blendet nur aus — die Datei
          bleibt revisionssicher aufbewahrt.
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
