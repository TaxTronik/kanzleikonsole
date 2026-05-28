'use client';

import { useMemo, useState, useTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Folder, FileText, ChevronRight, Search, FolderPlus,
  Download, RotateCcw, Trash2, Pencil, FolderInput, Tag, X, CornerLeftUp, Check,
  Share2, EyeOff,
} from 'lucide-react';
import { DocumentPreviewModal } from '@/components/document-preview';
import { DocumentUploadButton } from '@/components/document-upload-button';
import { RetagDialog } from '@/components/document-dialogs';
import {
  softDeleteDocumentAction,
  restoreDocumentAction,
  retagDocumentAction,
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
  type Crumb,
  type Entry,
  type FolderNode,
} from '@/components/document-browser-utils';

export type { Crumb, Entry };
type Sel = { kind: 'file' | 'folder'; id: string };

export function DocumentBrowser({
  crumbs, entries, scope, folders, currentFolderId, deleted, q, toggleDeletedHref,
}: {
  crumbs: Crumb[];
  entries: Entry[];
  scope: { clientId: string | null; typeParam: string } | null;
  folders: FolderNode[];
  currentFolderId: string | null;
  deleted: boolean;
  q: string;
  toggleDeletedHref?: string;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [search, setSearch] = useState(q);
  const [sel, setSel] = useState<Sel[]>([]);
  const [retagDoc, setRetagDoc] = useState<Extract<Entry, { kind: 'file' }> | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{ id: string; name: string } | null>(null);
  const [bulkRetag, setBulkRetag] = useState(false);
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
    const name = window.prompt('Name des neuen Ordners:');
    if (!name?.trim()) return;
    start(async () => {
      const r = await createFolderAction({
        clientId: scope.clientId, parentId: currentFolderId, name: name.trim(),
      });
      if (!r.ok) alert(r.error); else router.refresh();
    });
  }

  // ---- Verschieben (eine Menge → Ziel-Ordner-ID | null=Wurzel) ----
  function moveSet(items: Sel[], target: string | null) {
    if (items.length === 0) return;
    start(async () => {
      const errs: string[] = [];
      for (const it of items) {
        if (it.kind === 'file') {
          const r = await setDocumentFolderAction({ documentId: it.id, folderId: target });
          if (!r.ok) errs.push(r.error ?? 'Fehler');
        } else {
          // Ordner nicht in sich/Teilbaum
          if (target && descendants(folders, it.id).has(target)) {
            errs.push('Ordner kann nicht in seinen eigenen Unterbaum.');
            continue;
          }
          const r = await moveFolderAction({ folderId: it.id, newParentId: target });
          if (!r.ok) errs.push(r.error ?? 'Fehler');
        }
      }
      if (errs.length) alert([...new Set(errs)].join('\n'));
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
    if (!confirm(`„${name}" löschen?\nDie Datei bleibt revisionssicher aufbewahrt (Object-Lock), wird nur ausgeblendet.`)) return;
    start(async () => {
      const r = await softDeleteDocumentAction({ documentId: id });
      if (!r.ok) alert(r.error); else router.refresh();
    });
  }
  function toggleShare(id: string, share: boolean) {
    start(async () => {
      const r = await setDocumentShareAction({ documentId: id, share });
      if (!r.ok) alert(r.error); else router.refresh();
    });
  }
  function restore(id: string) {
    start(async () => {
      const r = await restoreDocumentAction({ documentId: id });
      if (!r.ok) alert(r.error); else router.refresh();
    });
  }
  function renameFolder(id: string, cur: string) {
    const name = window.prompt('Neuer Name:', cur);
    if (!name?.trim()) return;
    start(async () => {
      const r = await renameFolderAction({ folderId: id, name: name.trim() });
      if (!r.ok) alert(r.error); else router.refresh();
    });
  }
  function deleteFolder(id: string, name: string) {
    if (!confirm(`Ordner „${name}" löschen?\nInhalt rückt eine Ebene hoch. Kein Dokument wird gelöscht.`)) return;
    start(async () => {
      const r = await deleteFolderAction({ folderId: id });
      if (!r.ok) alert(r.error); else router.refresh();
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
    if (!typeId) { alert('Kein Datei-Typ verfügbar.'); return; }
    start(async () => {
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
      if (errs.length) alert(`Upload-Fehler:\n${errs.join('\n')}`);
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
                onClick={() => setBulkRetag(true)}
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
                  onClick={() =>
                    start(async () => {
                      for (const s of sel) await setDocumentShareAction({ documentId: s.id, share: true });
                      clearSel(); router.refresh();
                    })
                  }
                  className="btn-secondary text-xs py-1.5 !text-green-700"
                >
                  <Share2 className="h-4 w-4" /> Freigeben
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    start(async () => {
                      for (const s of sel) await setDocumentShareAction({ documentId: s.id, share: false });
                      clearSel(); router.refresh();
                    })
                  }
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
                  if (!confirm(`${sel.length} Dokument(e) löschen? Bleiben revisionssicher aufbewahrt, nur ausgeblendet.`)) return;
                  start(async () => {
                    for (const s of sel) await softDeleteDocumentAction({ documentId: s.id });
                    clearSel(); router.refresh();
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
                    onClick={() => setPreviewDoc({ id: e.id, name: e.name })}
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
                        {scope?.clientId && !e.deletedAt && (
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded border inline-flex items-center gap-0.5 ${
                              e.shared
                                ? 'bg-green-50 text-green-700 border-green-200'
                                : 'bg-gray-50 text-muted border-default'
                            }`}
                          >
                            {e.shared ? <Share2 className="h-2.5 w-2.5" /> : <EyeOff className="h-2.5 w-2.5" />}
                            {e.shared ? 'geteilt' : 'privat'}
                          </span>
                        )}
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
                      <button type="button" disabled={busy} title="Wiederherstellen" onClick={() => restore(e.id)} className="icon-btn">
                        <RotateCcw className="h-4 w-4" />
                      </button>
                    ) : (
                      <>
                        {scope?.clientId && (
                          <button
                            type="button"
                            disabled={busy}
                            title={e.shared ? 'Freigabe für Mandant zurückziehen' : 'Für Mandant freigeben'}
                            onClick={() => toggleShare(e.id, !e.shared)}
                            className={`p-1.5 ${e.shared ? 'text-green-600 hover:text-green-700' : 'text-disabled hover:text-brand-700'}`}
                          >
                            {e.shared ? <Share2 className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                          </button>
                        )}
                        <button type="button" title="Typ ändern" onClick={() => setRetagDoc(e)} className="icon-btn">
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
              <MenuItem icon={Pencil} label="Umbenennen" onClick={() => { renameFolder(ctx.e.id, ctx.e.name); setCtx(null); }} />
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
                  <MenuItem icon={Tag} label="Typ ändern" onClick={() => { setRetagDoc(ctx.e as Extract<Entry, { kind: 'file' }>); setCtx(null); }} />
                  <MenuItem icon={Trash2} label="Löschen" danger onClick={() => { softDelete(ctx.e.id, ctx.e.name); setCtx(null); }} />
                </>
              )}
              {'deletedAt' in ctx.e && ctx.e.deletedAt && (
                <MenuItem icon={RotateCcw} label="Wiederherstellen" onClick={() => { restore(ctx.e.id); setCtx(null); }} />
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
      {retagDoc && (
        <RetagDialog
          documentId={retagDoc.id}
          documentTitle={retagDoc.name}
          currentTier={retagDoc.tier}
          currentTypeId={retagDoc.typeId}
          onClose={() => setRetagDoc(null)}
          onDone={() => { setRetagDoc(null); router.refresh(); }}
        />
      )}
      {previewDoc && (
        <DocumentPreviewModal
          documentId={previewDoc.id}
          documentTitle={previewDoc.name}
          onClose={() => setPreviewDoc(null)}
        />
      )}
      {bulkRetag && (
        <BulkRetagDialog
          fileIds={sel.filter((s) => s.kind === 'file').map((s) => s.id)}
          onClose={() => setBulkRetag(false)}
          onDone={() => { setBulkRetag(false); clearSel(); router.refresh(); }}
        />
      )}
    </div>
  );
}

function BulkRetagDialog({
  fileIds, onClose, onDone,
}: {
  fileIds: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [types, setTypes] = useState<{ id: string; name: string; tier: 'NONE' | 'GWG' | 'GOBD' }[]>([]);
  const [sel, setSel] = useState('');
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let c = false;
    (async () => {
      try {
        const r = await fetch('/api/staff/document-types');
        if (!r.ok) return;
        const d = (await r.json()) as { types: typeof types };
        if (!c) setTypes(d.types);
      } catch { /* ignore */ }
    })();
    return () => { c = true; };
  }, []);
  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-md card p-6 relative" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={onClose} className="modal-close">
          <X className="h-5 w-5" />
        </button>
        <h2 className="text-base font-semibold text-primary mb-1">
          Typ ändern — {fileIds.length} Dokument(e)
        </h2>
        <p className="text-xs text-muted mb-3">
          Herabstufungen (GoBD/GwG → schwächer) werden serverseitig je Datei
          abgelehnt und am Ende zusammengefasst.
        </p>
        <select className="input mb-3" value={sel} onChange={(e) => setSel(e.target.value)}>
          <option value="">— Typ wählen —</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}{t.tier !== 'NONE' ? ` — ${t.tier === 'GOBD' ? 'GoBD 10 J.' : 'GwG 5 J.'}` : ''}
            </option>
          ))}
        </select>
        {msg && <div className="rounded bg-amber-50 p-2 text-xs text-amber-800 mb-3 whitespace-pre-line">{msg}</div>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="btn-secondary flex-1">Abbrechen</button>
          <button
            type="button"
            disabled={busy || !sel}
            onClick={() =>
              start(async () => {
                setMsg(null);
                let ok = 0;
                const errs: string[] = [];
                for (const id of fileIds) {
                  const r = await retagDocumentAction({ documentId: id, documentTypeId: sel });
                  if (r.ok) ok++; else errs.push(r.error ?? 'Fehler');
                }
                if (errs.length === 0) onDone();
                else setMsg(`${ok} geändert, ${errs.length} abgelehnt:\n${[...new Set(errs)].join('\n')}`);
              })
            }
            className="btn-primary flex-1"
          >
            {busy ? 'Ändert…' : 'Anwenden'}
          </button>
        </div>
      </div>
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

function MoveTargetDialog({
  folders, movingFolderIds, onClose, onPick,
}: {
  folders: FolderNode[];
  movingFolderIds: string[];
  onClose: () => void;
  onPick: (target: string | null) => void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Ziele, die im Teilbaum eines zu verschiebenden Ordners liegen, sperren.
  const blocked = useMemo(() => {
    const b = new Set<string>();
    for (const id of movingFolderIds) for (const d of descendants(folders, id)) b.add(d);
    return b;
  }, [folders, movingFolderIds]);
  const childrenOf = useMemo(() => {
    const m = new Map<string | null, FolderNode[]>();
    for (const f of [...folders].sort((a, b) => a.name.localeCompare(b.name, 'de')))
      m.set(f.parentId, [...(m.get(f.parentId) ?? []), f]);
    return m;
  }, [folders]);

  function row(f: FolderNode, depth: number) {
    const kids = childrenOf.get(f.id) ?? [];
    const open = expanded[f.id];
    const dis = blocked.has(f.id);
    return (
      <div key={f.id}>
        <div
          className={`flex items-center gap-1 rounded px-2 py-1.5 text-sm ${
            dis ? 'opacity-40 cursor-not-allowed'
            : target === f.id ? 'bg-brand-50 text-brand-700 cursor-pointer'
            : 'hover:bg-gray-50 text-secondary cursor-pointer'
          }`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => !dis && setTarget(f.id)}
        >
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setExpanded((x) => ({ ...x, [f.id]: !x[f.id] })); }}
            className={kids.length ? 'text-disabled' : 'invisible'}
          >
            <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
          </button>
          <Folder className="h-4 w-4" />
          <span className="truncate flex-1">{f.name}</span>
          {target === f.id && <Check className="h-3.5 w-3.5" />}
        </div>
        {open && kids.map((k) => row(k, depth + 1))}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-md card p-6 relative" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={onClose} className="modal-close">
          <X className="h-5 w-5" />
        </button>
        <h2 className="text-base font-semibold text-primary mb-3">Verschieben nach…</h2>
        <div className="border border-default rounded-md max-h-72 overflow-auto p-1">
          <div
            className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm cursor-pointer ${
              target === null ? 'bg-brand-50 text-brand-700' : 'hover:bg-gray-50 text-secondary'
            }`}
            onClick={() => setTarget(null)}
          >
            <Folder className="h-4 w-4 text-disabled" />
            <span className="flex-1">— Wurzel (ohne Ordner) —</span>
            {target === null && <Check className="h-3.5 w-3.5" />}
          </div>
          {(childrenOf.get(null) ?? []).map((f) => row(f, 0))}
          {folders.length === 0 && (
            <p className="px-2 py-3 text-xs text-disabled">Keine Ordner in diesem Bereich.</p>
          )}
        </div>
        <div className="flex gap-2 mt-4">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">Abbrechen</button>
          <button type="button" onClick={() => onPick(target)} className="btn-primary flex-1">
            Hierher verschieben
          </button>
        </div>
      </div>
    </div>
  );
}
