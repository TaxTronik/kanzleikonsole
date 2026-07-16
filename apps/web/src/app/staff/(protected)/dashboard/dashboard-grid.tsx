'use client';

import { useState, useRef, useEffect, type ReactNode } from 'react';
import { GridLayout, useContainerWidth, type Layout, type LayoutItem } from 'react-grid-layout';
import { Plus, Settings2, RotateCcw, Check, X, Loader2 } from 'lucide-react';
import {
  WIDGETS,
  WIDGET_BY_TYPE,
  DEFAULT_SIZE,
  type DashboardLayout,
  type LayoutWidget,
  type WidgetType,
} from '@/server/dashboard/widgets';
import {
  addDashboardWidgetAction,
  saveDashboardLayoutAction,
  resetDashboardLayoutAction,
} from './actions';
import { createDashboardMutationQueue, snapshotForQueuedDashboardAdd } from './mutation-queue';

// IDs für neu hinzugefügte Widgets. Wird nur in Click-Handlern aufgerufen
// (kein Render-Pfad → keine Hydration-Differenz möglich). crypto.randomUUID
// statt Math.random — sauber, kollisionsfrei, ohne Workaround.
function uid(): string {
  return 'w-' + crypto.randomUUID();
}

// Erste-passierende freie Position auf dem 12-Spalten-Grid (First-Fit), statt
// neue Widgets stur unten links anzuhängen (x:0/y:maxY). Nutzt bestehenden
// Freiraum neben anderen Widgets und hält das Dashboard kompakt — löst das
// „alles untereinander"-Problem.
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
          if (occupied.has(`${ix},${iy}`)) {
            fits = false;
            break;
          }
        }
        if (!fits) break;
      }
      if (fits) return { x, y };
    }
  }
  const maxY = existing.reduce((acc, item) => Math.max(acc, item.y + item.h), 0);
  return { x: 0, y: maxY };
}

interface RenderedWidget {
  widget: LayoutWidget;
  node: ReactNode;
}

export function DashboardGrid({
  initialLayout,
  initialRendered,
}: {
  initialLayout: DashboardLayout;
  initialRendered: RenderedWidget[];
}) {
  const [editMode, setEditMode] = useState(false);
  const [widgets, setWidgets] = useState<LayoutWidget[]>(initialLayout.widgets);
  const [renderedWidgets, setRenderedWidgets] = useState(initialRendered);
  const [pendingWidgetIds, setPendingWidgetIds] = useState<Set<string>>(() => new Set());
  // Synchroner Spiegel des Widget-States: Click-Handler lesen die aktuellste
  // Liste auch bei schnellen Mehrfach-Klicks (vor dem nächsten Render), ohne
  // Seitenwirkungen in setWidgets-Updatern absetzen zu müssen. Fixt das
  // „weiterhin als hinzufügbar"-Verhalten bei rapid Adds.
  const widgetsRef = useRef(widgets);
  widgetsRef.current = widgets;
  const [error, setError] = useState<string | null>(null);
  // settled=false beim ersten Paint → der Grid bleibt per Inline-Style
  // `visibility:hidden` UNSICHTBAR (Layout-Dimensionen bleiben erhalten, die
  // Breitenmessung stimmt also weiter) und die CSS-Klasse unterdrückt zusätzlich
  // die Item-Transition. So „fahren" die Widgets nicht von links aus, sondern
  // erscheinen nach zwei Frames (Position committet) sofort an ihrer Position.
  // Der Inline-Style ist timing-unabhängig von der CSS-Injektion (in Turbopack-
  // Dev wird CSS per JS injiziert → bei Hard-Reload kann RGLs eigenes
  // `transition`-CSS sonst einen Frame vor der Suppression-Klasse ankommen).
  // Danach auf true → Drag/Resize animieren wieder normal.
  const [settled, setSettled] = useState(false);
  const [resetting, setResetting] = useState(false);
  const resettingRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Layout-Actions schreiben jeweils einen vollstaendigen Snapshot. Deshalb
  // muessen Add/Remove/Drag in Aufrufreihenfolge beim Server ankommen: Bei
  // parallelen Requests koennte sonst ein langsamer alter Snapshot einen
  // bereits gespeicherten neueren Stand wieder ueberschreiben.
  const [mutationQueue] = useState(createDashboardMutationQueue);
  const { width, containerRef, mounted } = useContainerWidth();

  const renderById = new Map(
    renderedWidgets.map((rendered) => [rendered.widget.id, rendered.node]),
  );

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setSettled(true)));
    return () => cancelAnimationFrame(id);
  }, [mounted]);

  function enqueueMutation(task: () => Promise<void>): Promise<void> {
    return mutationQueue.enqueue(task);
  }

  function persist() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void enqueueMutation(async () => {
        // Erst bei Ausfuehrung lesen: Waerend des Debounce oder einer zuvor
        // laufenden Add-Action kann das Layout bereits weitergeaendert sein.
        const snapshot = [...widgetsRef.current];
        const r = await saveDashboardLayoutAction({ version: 2, widgets: snapshot });
        if (!r.ok) setError(r.error ?? 'Fehler beim Speichern.');
      });
    }, 600);
  }

  function onLayoutChange(next: Layout) {
    setWidgets((current) => {
      if (resettingRef.current) return current;
      const byId = new Map(current.map((w) => [w.id, w]));
      const updated: LayoutWidget[] = [];
      for (const l of next) {
        const w = byId.get(l.i);
        if (!w) continue;
        updated.push({ ...w, x: l.x, y: l.y, w: l.w, h: l.h });
      }
      // Nur persist, wenn sich tatsächlich etwas geändert hat
      const same =
        updated.length === current.length &&
        updated.every((u, i) => {
          const c = current[i];
          return c && c.id === u.id && c.x === u.x && c.y === u.y && c.w === u.w && c.h === u.h;
        });
      if (!same && editMode) {
        widgetsRef.current = updated;
        persist();
      }
      return updated;
    });
  }

  function add(type: WidgetType) {
    if (resettingRef.current) return;
    // Gegen veraltete Closures: gegen den synchronen Ref prüfen, nicht gegen
    // den Render-Snapshot `widgets` (sonst verschwinden Widgets bei schnellen
    // Mehrfach-Klicks und tauchen wieder als hinzufügbar auf).
    const current = widgetsRef.current;
    if (current.some((w) => w.type === type)) return;
    const def = DEFAULT_SIZE[type];
    const pos = findFreeSlot(current, def.w, def.h);
    const widget: LayoutWidget = { id: uid(), type, x: pos.x, y: pos.y, w: def.w, h: def.h };
    const next: LayoutWidget[] = [...current, widget];
    const includedSnapshotIds = new Set(next.map((entry) => entry.id));
    widgetsRef.current = next;
    setWidgets(next);
    setPendingWidgetIds((pending) => new Set(pending).add(widget.id));
    void enqueueMutation(async () => {
      const currentWidget = widgetsRef.current.find((entry) => entry.id === widget.id);
      if (!currentWidget) return;
      // Den Live-Stand nur bis zu dieser Add-Mutation lesen: Ein früher
      // Request darf ein später optimistisch hinzugefügtes Widget noch nicht
      // persistieren. Dessen eigene Queue-Mutation folgt anschließend.
      const snapshot = snapshotForQueuedDashboardAdd(widgetsRef.current, includedSnapshotIds);
      const r = await addDashboardWidgetAction({ version: 2, widgets: snapshot }, widget.id);
      if (!r.ok || !r.rendered) {
        setError(r.error ?? 'Fehler beim Speichern.');
        const rolledBack = widgetsRef.current.filter((entry) => entry.id !== widget.id);
        widgetsRef.current = rolledBack;
        setWidgets(rolledBack);
        return;
      }
      setRenderedWidgets((currentRendered) => [
        ...currentRendered.filter((entry) => entry.widget.id !== widget.id),
        r.rendered!,
      ]);
    })
      .catch(() => {
        setError('Fehler beim Speichern — bitte erneut versuchen.');
        const rolledBack = widgetsRef.current.filter((entry) => entry.id !== widget.id);
        widgetsRef.current = rolledBack;
        setWidgets(rolledBack);
      })
      .finally(() => {
        setPendingWidgetIds((pending) => {
          const nextPending = new Set(pending);
          nextPending.delete(widget.id);
          return nextPending;
        });
      });
  }

  function remove(id: string) {
    if (resettingRef.current) return;
    const current = widgetsRef.current;
    const next = current.filter((w) => w.id !== id);
    widgetsRef.current = next;
    setWidgets(next);
    setRenderedWidgets((rendered) => rendered.filter((entry) => entry.widget.id !== id));
    persist();
  }

  async function reset() {
    if (resettingRef.current) return;
    if (!confirm('Standard-Layout wiederherstellen?')) return;
    resettingRef.current = true;
    setResetting(true);
    setEditMode(false);
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    try {
      await enqueueMutation(async () => {
        const r = await resetDashboardLayoutAction();
        if (!r.ok) {
          resettingRef.current = false;
          setResetting(false);
          setError(r.error ?? 'Fehler.');
          return;
        }
        window.location.reload();
      });
    } catch {
      resettingRef.current = false;
      setResetting(false);
      setError('Standard-Layout konnte nicht wiederhergestellt werden.');
    }
  }

  const visible = widgets.filter((w) => renderById.has(w.id) || pendingWidgetIds.has(w.id));
  const rglLayout: LayoutItem[] = visible.map((w) => {
    const def = DEFAULT_SIZE[w.type];
    return {
      i: w.id,
      x: w.x,
      y: w.y,
      w: w.w,
      h: w.h,
      minW: def?.minW ?? 2,
      minH: def?.minH ?? 2,
    };
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-2">
        {editMode && (
          <button
            type="button"
            onClick={reset}
            className="btn-secondary text-xs"
            title="Auf Standard zurücksetzen"
            disabled={resetting}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Standard
          </button>
        )}
        <button
          type="button"
          onClick={() => setEditMode((v) => !v)}
          className={editMode ? 'btn-primary text-xs' : 'btn-secondary text-xs'}
        >
          {editMode ? <Check className="h-3.5 w-3.5" /> : <Settings2 className="h-3.5 w-3.5" />}
          {editMode ? 'Fertig' : 'Anpassen'}
        </button>
      </div>

      {error && <div className="alert-error-sm">{error}</div>}

      {editMode && <AddWidgetBar widgets={widgets} onAdd={add} />}

      <div
        ref={containerRef}
        className={
          (editMode ? 'dashboard-edit relative' : 'relative') +
          (settled ? '' : ' dashboard-grid-initial')
        }
        style={settled ? undefined : { visibility: 'hidden' }}
      >
        {mounted && (
          <GridLayout
            width={width}
            layout={rglLayout}
            gridConfig={{ cols: 12, rowHeight: 30, margin: [16, 16], containerPadding: [0, 0] }}
            dragConfig={{ enabled: editMode, cancel: '.widget-remove' }}
            resizeConfig={{
              enabled: editMode,
              handles: ['se', 'sw', 'ne', 'nw', 'e', 'w', 's', 'n'],
            }}
            onLayoutChange={onLayoutChange}
          >
            {visible.map((w) => (
              <div
                key={w.id}
                className={'relative ' + (editMode ? 'ring-2 ring-brand-300 rounded-xl' : '')}
              >
                {editMode && (
                  <button
                    type="button"
                    onClick={() => remove(w.id)}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="widget-remove absolute -top-2 -right-2 z-10 bg-surface border border-default rounded-full p-1 shadow-sm text-disabled hover:text-red-700"
                    title="Widget entfernen"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
                <div className="h-full widget-shell">
                  {renderById.get(w.id) ?? (
                    <div className="card flex h-full items-center justify-center gap-2 text-sm text-muted">
                      <Loader2 className="h-4 w-4 animate-spin" /> Widget wird geladen …
                    </div>
                  )}
                </div>
              </div>
            ))}
          </GridLayout>
        )}
      </div>

      {visible.length === 0 && (
        <div className="card p-12 text-center text-sm text-muted">
          Kein Widget aktiv. Klicke auf „Anpassen" und füge Widgets hinzu.
        </div>
      )}
    </div>
  );
}

function AddWidgetBar({
  widgets,
  onAdd,
}: {
  widgets: LayoutWidget[];
  onAdd: (t: WidgetType) => void;
}) {
  // Pro Widget-Typ nur einmal auf dem Dashboard — Dopplungen sind nicht
  // sinnvoll und verwirren beim Auto-Reflow.
  const usedTypes = new Set(widgets.map((w) => w.type));
  const available = WIDGETS.filter((w) => !usedTypes.has(w.type));
  return (
    <div className="card p-3">
      <p className="text-xs font-medium text-secondary mb-2">
        Widget hinzufügen
        {available.length === 0 && (
          <span className="ml-2 font-normal text-muted">— alle bereits auf dem Dashboard</span>
        )}
      </p>
      {available.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {available.map((w) => (
            <button
              key={w.type}
              type="button"
              onClick={() => onAdd(w.type)}
              className="btn-secondary text-xs py-1"
              title={w.description}
            >
              <Plus className="h-3 w-3" />
              {WIDGET_BY_TYPE[w.type]?.label ?? w.type}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
