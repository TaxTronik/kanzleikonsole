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

import { useMemo, useState, useEffect, type SubmitEvent } from 'react';
import Link from 'next/link';
import {
  Folder,
  FileText,
  ChevronRight,
  Search,
  FolderPlus,
  Download,
  RotateCcw,
  Trash2,
  Pencil,
  FolderInput,
  Tag,
  CornerLeftUp,
  Share2,
  EyeOff,
} from 'lucide-react';
import { DocumentUploadButton } from '@/components/document-upload-button';
import { MoveTargetDialog } from '@/components/document-dialogs';
import {
  softDeleteDocumentAction,
  setDocumentShareAction,
} from '@/app/staff/(protected)/documents/actions';
import {
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
  type Entry,
} from '@/components/document-browser-utils';

import { OpErrorBanner, ShareBadge, TruncationHint, type DocumentOps } from './ops';
import type { BrowserProps } from './types';

// ---------------------------------------------------------------------------
// Variante „browser" — /staff/documents (URL-getrieben, Explorer-Stil)
// ---------------------------------------------------------------------------

type Sel = { kind: 'file' | 'folder'; id: string };

export function BrowserView({
  crumbs,
  entries,
  scope,
  folders,
  currentFolderId,
  deleted,
  q,
  toggleDeletedHref,
  truncated,
  totalCount,
  ops,
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
        return has
          ? prev.filter((s) => !(s.kind === kind && s.id === id))
          : [...prev, { kind, id }];
      }
      return has && prev.length === 1 ? [] : [{ kind, id }];
    });
  }
  const clearSel = () => setSel([]);

  function applySearch(ev: SubmitEvent<HTMLFormElement>) {
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
      moveSet(
        items.filter((i) => !(i.kind === 'folder' && i.id === target)),
        target,
      );
    } catch {
      console.warn('[doc-explorer] Drag-Drop-Payload konnte nicht geparst werden');
    }
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
  function uploadDropped(files: File[]) {
    if (!scope || deleted || files.length === 0) return;
    void (async () => {
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
            d.types[0]?.id ??
            '';
        }
      } catch {
        console.warn('[doc-explorer] Datei-Typ-Ermittlung fehlgeschlagen');
      }
      if (!typeId) {
        ops.setOpError('Kein Datei-Typ verfügbar.');
        return;
      }
      start(() => {
        void (async () => {
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
        })().catch((err) => {
          console.warn('[doc-explorer] Drop-Upload fehlgeschlagen', err);
          ops.setOpError('Drop-Upload fehlgeschlagen.');
        });
      });
    })().catch((err) => {
      console.warn('[doc-explorer] Drop-Upload fehlgeschlagen', err);
      ops.setOpError('Drop-Upload fehlgeschlagen.');
    });
  }
  // Unterscheidet OS-Datei-Drop (dataTransfer.types enthält 'Files') vom
  // internen Verschieben (text/plain mit unserer Payload).
  const isOsFileDrag = (dt: DataTransfer) => Array.from(dt.types).includes('Files');

  return (
    <div
      className="p-8 relative"
      onContextMenu={(e) => {
        if (ctx) e.preventDefault();
      }}
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
              <Link href={c.href} className="hover:text-brand-700 hover:underline">
                {c.label}
              </Link>
            )}
          </span>
        ))}
      </nav>

      {/* Toolbar / Auswahl-Leiste */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        {sel.length > 0 ? (
          <>
            <span className="text-sm font-medium text-secondary">{sel.length} ausgewählt</span>
            <button
              type="button"
              onClick={() => setMoveOpen(true)}
              disabled={busy}
              className="btn-secondary text-xs py-1.5"
            >
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
              {sel.length > 1 || sel.some((s) => s.kind === 'folder')
                ? 'Als ZIP laden'
                : 'Herunterladen'}
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
            <button
              type="button"
              onClick={clearSel}
              className="text-xs text-muted hover:text-secondary"
            >
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
                <button
                  type="button"
                  onClick={newFolder}
                  disabled={busy}
                  className="btn-secondary text-xs py-1.5"
                >
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

      {truncated && (
        <TruncationHint
          shown={entries.filter((e) => e.kind === 'file').length}
          totalCount={totalCount}
        />
      )}

      {/* „Eine Ebene hoch" als Drop-Ziel (Wurzel des Scopes) */}
      {scope && currentFolderId && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDropTarget('root');
          }}
          onDragLeave={() => setDropTarget(null)}
          onDrop={(e) => {
            setDropTarget(null);
            onDropInto(null, e.dataTransfer.getData('text/plain'));
          }}
          className={`mb-2 flex items-center gap-2 rounded-md border border-dashed px-3 py-1.5 text-xs ${
            dropTarget === 'root'
              ? 'border-brand-500 bg-brand-50 text-brand-700'
              : 'border-default text-disabled'
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
          <p className="text-sm text-disabled">
            {deleted ? 'Keine gelöschten Dokumente hier.' : 'Dieser Ordner ist leer.'}
          </p>
        </div>
      ) : (
        <div className="card overflow-hidden divide-y divide-border-subtle">
          {entries.map((e) => {
            const sk = e.kind !== 'nav';
            const selectedRow = sk && isSel(e.kind as 'file' | 'folder', e.id);
            const isDrop = e.kind === 'folder' && dropTarget === e.id;
            const Icon =
              e.kind === 'file'
                ? fileIcon(e.mimeType)
                : e.kind === 'folder'
                  ? Folder
                  : navIcon(e.icon);
            return (
              <div
                key={`${e.kind}-${e.id}`}
                data-document-id={e.kind === 'file' ? e.id : undefined}
                draggable={sk}
                onDragStart={(ev) => {
                  const p = dragPayload(e);
                  ev.dataTransfer.setData('text/plain', JSON.stringify(p));
                  ev.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={
                  e.kind === 'folder'
                    ? (ev) => {
                        ev.preventDefault();
                        setDropTarget(e.id);
                      }
                    : undefined
                }
                onDragLeave={e.kind === 'folder' ? () => setDropTarget(null) : undefined}
                onDrop={
                  e.kind === 'folder'
                    ? (ev) => {
                        ev.preventDefault();
                        setDropTarget(null);
                        onDropInto(e.id, ev.dataTransfer.getData('text/plain'));
                      }
                    : undefined
                }
                onContextMenu={(ev) => {
                  if (e.kind === 'nav') return;
                  ev.preventDefault();
                  if (sk && !isSel(e.kind as 'file' | 'folder', e.id))
                    toggle(e.kind as 'file' | 'folder', e.id, false);
                  setCtx({ x: ev.clientX, y: ev.clientY, e });
                }}
                className={`flex items-center gap-3 px-5 py-3 group ${
                  isDrop
                    ? 'bg-brand-50 ring-1 ring-inset ring-brand-300'
                    : selectedRow
                      ? 'bg-brand-50/60'
                      : 'hover:bg-gray-50'
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
                        <span className="font-medium text-primary truncate hover:underline">
                          {e.name}
                        </span>
                        {e.tier !== 'NONE' && (
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded border ${
                              e.tier === 'GOBD'
                                ? 'bg-red-50 text-red-700 border-red-200'
                                : 'bg-amber-50 text-amber-700 border-amber-200'
                            }`}
                          >
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
                    <a
                      href={`/api/staff/documents/${e.id}/download`}
                      className="text-disabled hover:text-primary p-1.5 inline-flex items-center"
                      title="Herunterladen"
                    >
                      <Download className="h-4 w-4" />
                    </a>
                    {e.deletedAt ? (
                      <button
                        type="button"
                        disabled={busy}
                        title="Wiederherstellen"
                        onClick={() => ops.restoreDoc(e.id)}
                        className="icon-btn"
                      >
                        <RotateCcw className="h-4 w-4" />
                      </button>
                    ) : (
                      <>
                        {scope?.clientId && (
                          <button
                            type="button"
                            disabled={busy}
                            title={
                              e.shared
                                ? 'Freigabe für Mandant zurückziehen'
                                : 'Für Mandant freigeben'
                            }
                            onClick={() => ops.toggleShare(e.id, !e.shared)}
                            className={`p-1.5 ${e.shared ? 'text-green-600 hover:text-green-700' : 'text-disabled hover:text-brand-700'}`}
                          >
                            {e.shared ? (
                              <Share2 className="h-4 w-4" />
                            ) : (
                              <EyeOff className="h-4 w-4" />
                            )}
                          </button>
                        )}
                        <button
                          type="button"
                          title="Typ ändern"
                          onClick={() =>
                            ops.setRetag({
                              ids: [e.id],
                              title: e.name,
                              tier: e.tier,
                              typeId: e.typeId,
                            })
                          }
                          className="icon-btn"
                        >
                          <Tag className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          title="Verschieben"
                          onClick={() => {
                            toggle('file', e.id, false);
                            setMoveOpen(true);
                          }}
                          className="icon-btn"
                        >
                          <FolderInput className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          title="Löschen"
                          disabled={busy}
                          onClick={() => softDelete(e.id, e.name)}
                          className="text-disabled hover:text-red-600 p-1.5"
                        >
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
              <MenuItem
                icon={Folder}
                label="Öffnen"
                onClick={() => router.push((ctx.e as { href: string }).href)}
              />
              <MenuItem
                icon={Download}
                label="Als ZIP laden"
                onClick={() => {
                  window.location.href = dlUrl([], [ctx.e.id]);
                  setCtx(null);
                }}
              />
              <MenuItem
                icon={Pencil}
                label="Umbenennen"
                onClick={() => {
                  ops.setRenameTarget({ id: ctx.e.id, name: ctx.e.name });
                  setCtx(null);
                }}
              />
              <MenuItem
                icon={FolderInput}
                label="Verschieben"
                onClick={() => {
                  setMoveOpen(true);
                  setCtx(null);
                }}
              />
              <MenuItem
                icon={Trash2}
                label="Löschen"
                danger
                onClick={() => {
                  deleteFolder(ctx.e.id, ctx.e.name);
                  setCtx(null);
                }}
              />
            </>
          )}
          {ctx.e.kind === 'file' && (
            <>
              <MenuItem
                icon={FileText}
                label="Details"
                onClick={() => router.push(`/staff/documents/${ctx.e.id}`)}
              />
              <MenuItem
                icon={Download}
                label="Herunterladen"
                onClick={() => {
                  window.location.href = `/api/staff/documents/${ctx.e.id}/download`;
                  setCtx(null);
                }}
              />
              {!('deletedAt' in ctx.e && ctx.e.deletedAt) && (
                <>
                  <MenuItem
                    icon={FolderInput}
                    label="Verschieben"
                    onClick={() => {
                      setMoveOpen(true);
                      setCtx(null);
                    }}
                  />
                  <MenuItem
                    icon={Tag}
                    label="Typ ändern"
                    onClick={() => {
                      const f = ctx.e as Extract<Entry, { kind: 'file' }>;
                      ops.setRetag({ ids: [f.id], title: f.name, tier: f.tier, typeId: f.typeId });
                      setCtx(null);
                    }}
                  />
                  <MenuItem
                    icon={Trash2}
                    label="Löschen"
                    danger
                    onClick={() => {
                      softDelete(ctx.e.id, ctx.e.name);
                      setCtx(null);
                    }}
                  />
                </>
              )}
              {'deletedAt' in ctx.e && ctx.e.deletedAt && (
                <MenuItem
                  icon={RotateCcw}
                  label="Wiederherstellen"
                  onClick={() => {
                    ops.restoreDoc(ctx.e.id);
                    setCtx(null);
                  }}
                />
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
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: typeof Folder;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
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
