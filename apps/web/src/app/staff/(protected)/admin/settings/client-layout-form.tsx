'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  GridLayout,
  useContainerWidth,
  type Layout,
  type LayoutItem,
} from 'react-grid-layout';
import { RotateCcw, Plus, X, Check, Settings2, CalendarDays, Workflow, CalendarClock, FolderInput, Inbox, Phone, Users, IdCard, ShieldCheck, ListChecks, FileText } from 'lucide-react';
import { saveClientLayoutAction, resetClientLayoutAction } from './actions';
import {
  ALL_CLIENT_BLOCKS,
  CLIENT_BLOCK_LABELS,
  BLOCK_SIZE,
  type ClientBlockKey,
  type ClientGridItem,
  type ClientLayoutConfig,
} from '@/server/settings/client-layout-shared';

const ICONS: Record<ClientBlockKey, typeof CalendarDays> = {
  contacts: Users,
  master_data: IdCard,
  gwg_status: ShieldCheck,
  custom_fields: ListChecks,
  upcoming: CalendarDays,
  workflows: Workflow,
  reminders: CalendarClock,
  binders: FolderInput,
  handovers: Inbox,
  phone_notes: Phone,
  requests: Inbox,
  documents: FileText,
};

// First-Fit auf dem 12-Spalten-Grid: nutzt bestehenden Freiraum statt neue
// Blöcke stur unten links anzuhängen (x:0/y:maxY).
function findFreeSlot(
  existing: { x: number; y: number; w: number; h: number }[],
  w: number,
  h: number,
  cols = 12,
): { x: number; y: number } {
  const occupied = new Set<string>();
  for (const item of existing) {
    for (let ix = item.x; ix < item.x + item.w; ix++) {
      for (let iy = item.y; iy < item.y + item.h; iy++) {
        occupied.add(`${ix},${iy}`);
      }
    }
  }
  for (let y = 0; y < 500; y++) {
    for (let x = 0; x <= cols - w; x++) {
      let fits = true;
      for (let ix = x; ix < x + w; ix++) {
        for (let iy = y; iy < y + h; iy++) {
          if (occupied.has(`${ix},${iy}`)) { fits = false; break; }
        }
        if (!fits) break;
      }
      if (fits) return { x, y };
    }
  }
  const maxY = existing.reduce((acc, item) => Math.max(acc, item.y + item.h), 0);
  return { x: 0, y: maxY };
}

export function ClientLayoutForm({ initial }: { initial: ClientLayoutConfig }) {
  const router = useRouter();
  const [editMode, setEditMode] = useState(false);
  const [items, setItems] = useState<ClientGridItem[]>(initial.items);
  // Synchroner Spiegel: Click-Handler sehen die aktuellste Liste auch bei
  // schnellen Mehrfach-Klicks (vor dem nächsten Render).
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { width, containerRef, mounted } = useContainerWidth();

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  function persist(next: ClientGridItem[]) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const r = await saveClientLayoutAction({ items: next });
      if (!r.ok) setError(r.error ?? 'Fehler beim Speichern.');
      else router.refresh();
    }, 600);
  }

  function onLayoutChange(next: Layout) {
    setItems((current) => {
      const byId = new Map(current.map((it) => [it.id, it]));
      const updated: ClientGridItem[] = [];
      for (const l of next) {
        const it = byId.get(l.i as ClientBlockKey);
        if (!it) continue;
        updated.push({ ...it, x: l.x, y: l.y, w: l.w, h: l.h });
      }
      const same =
        updated.length === current.length &&
        updated.every((u, i) => {
          const c = current[i];
          return c && c.id === u.id && c.x === u.x && c.y === u.y && c.w === u.w && c.h === u.h;
        });
      if (!same && editMode) persist(updated);
      return updated;
    });
  }

  function add(key: ClientBlockKey) {
    const current = itemsRef.current;
    if (current.some((it) => it.id === key)) return;
    const def = BLOCK_SIZE[key];
    const pos = findFreeSlot(current, def.w, def.h);
    const next: ClientGridItem[] = [
      ...current,
      { id: key, x: pos.x, y: pos.y, w: def.w, h: def.h },
    ];
    itemsRef.current = next;
    setItems(next);
    persist(next);
  }

  function remove(key: ClientBlockKey) {
    const current = itemsRef.current;
    const next = current.filter((it) => it.id !== key);
    itemsRef.current = next;
    setItems(next);
    persist(next);
  }

  async function reset() {
    if (!confirm('Standard-Layout wiederherstellen?')) return;
    const r = await resetClientLayoutAction();
    if (!r.ok) {
      setError(r.error ?? 'Fehler.');
      return;
    }
    window.location.reload();
  }

  const rglLayout: LayoutItem[] = items.map((it) => {
    const def = BLOCK_SIZE[it.id];
    return {
      i: it.id,
      x: it.x, y: it.y, w: it.w, h: it.h,
      minW: def.minW, minH: def.minH,
    };
  });

  const usedKeys = new Set(items.map((it) => it.id));
  const available = ALL_CLIENT_BLOCKS.filter((k) => !usedKeys.has(k));

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-muted flex-1">
          Tenant-globales Layout für das Mandanten-Cockpit (Block-Bereich auf
          <code className="mx-1 px-1 rounded bg-gray-100">/staff/clients/:id</code>).
          Anpassungen gelten für alle Mitarbeiter. Deaktivierte Module erscheinen
          nicht — die Position bleibt aber gespeichert.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          {editMode && (
            <button
              type="button"
              onClick={reset}
              className="btn-secondary text-xs inline-flex items-center gap-1"
              title="Auf Standard zurücksetzen"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Standard
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditMode((v) => !v)}
            className={editMode ? 'btn-primary text-xs inline-flex items-center gap-1' : 'btn-secondary text-xs inline-flex items-center gap-1'}
          >
            {editMode ? <Check className="h-3.5 w-3.5" /> : <Settings2 className="h-3.5 w-3.5" />}
            {editMode ? 'Fertig' : 'Anpassen'}
          </button>
        </div>
      </div>

      {error && <div className="rounded-md bg-red-50 p-2 text-xs text-red-700">{error}</div>}

      {editMode && available.length > 0 && (
        <div className="card p-3">
          <p className="text-xs font-medium text-secondary mb-2">
            Block hinzufügen
          </p>
          <div className="flex flex-wrap gap-2">
            {available.map((k) => {
              const Icon = ICONS[k];
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => add(k)}
                  className="btn-secondary text-xs inline-flex items-center gap-1"
                >
                  <Plus className="h-3 w-3" />
                  <Icon className="h-3.5 w-3.5" />
                  {CLIENT_BLOCK_LABELS[k]}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div ref={containerRef} className={editMode ? 'dashboard-edit relative' : 'relative'}>
        {mounted && items.length > 0 && (
          <GridLayout
            width={width}
            layout={rglLayout}
            gridConfig={{ cols: 12, rowHeight: 30, margin: [16, 16], containerPadding: [0, 0] }}
            dragConfig={{ enabled: editMode, cancel: '.block-remove' }}
            resizeConfig={{ enabled: editMode, handles: ['se', 'sw', 'ne', 'nw', 'e', 'w', 's', 'n'] }}
            onLayoutChange={onLayoutChange}
          >
            {items.map((it) => {
              const Icon = ICONS[it.id];
              return (
                <div
                  key={it.id}
                  className={
                    'relative card flex items-center justify-center text-sm text-secondary ' +
                    (editMode ? 'ring-2 ring-brand-300 rounded-xl' : '')
                  }
                >
                  {editMode && (
                    <button
                      type="button"
                      onClick={() => remove(it.id)}
                      onMouseDown={(e) => e.stopPropagation()}
                      className="block-remove absolute -top-2 -right-2 z-10 bg-surface border border-default rounded-full p-1 shadow-sm text-disabled hover:text-red-700"
                      title="Block entfernen"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                  <div className="flex flex-col items-center gap-2 px-4 text-center">
                    <Icon className="h-6 w-6 text-disabled" />
                    <span className="font-medium text-primary">
                      {CLIENT_BLOCK_LABELS[it.id]}
                    </span>
                    <span className="text-[10px] text-disabled font-mono">
                      {it.w} × {it.h}
                    </span>
                  </div>
                </div>
              );
            })}
          </GridLayout>
        )}
      </div>

      {items.length === 0 && (
        <div className="card p-8 text-center text-sm text-muted">
          Kein Block aktiv. Klicke auf „Anpassen" und füge Blöcke hinzu.
        </div>
      )}
    </div>
  );
}
