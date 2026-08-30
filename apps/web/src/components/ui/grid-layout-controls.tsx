'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  GRID_COLUMNS,
  GRID_MAX_HEIGHT,
  GRID_MAX_Y,
  gridGeometryDescription,
  type GridGeometry,
} from './grid-layout-geometry';

export interface GridControlItem extends GridGeometry {
  id: string;
  label: string;
  minW: number;
  minH: number;
}
interface GridLayoutControlsProps {
  widgets: GridControlItem[];
  itemKind: 'Widget' | 'Block';
  disabled: boolean;
  removeDisabled?: boolean;
  onApply: (id: string, geometry: GridGeometry) => void;
  onRemove: (id: string) => void;
}

export function GridLayoutControls({
  widgets,
  itemKind,
  disabled,
  removeDisabled = false,
  onApply,
  onRemove,
}: GridLayoutControlsProps) {
  const id = useId();
  const [selectedId, setSelectedId] = useState(widgets[0]?.id ?? '');
  const selected = widgets.find((widget) => widget.id === selectedId) ?? widgets[0];
  if (!selected) return null;

  return (
    <section
      className="card min-w-0 space-y-3 p-4"
      aria-labelledby={`${id}-heading`}
      data-grid-layout-controls
    >
      <h2 id={`${id}-heading`} className="text-sm font-semibold text-primary">
        Position und Größe ohne Ziehen
      </h2>
      <p id={`${id}-help`} className="text-sm text-secondary">
        {itemKind} auswählen und Werte eingeben. Erst „Übernehmen“ wendet die Änderung an und
        speichert sie automatisch. Das Raster hat zwölf Spalten; freie Lücken werden nach oben
        geschlossen. Andere Elemente können dabei ausweichen.
      </p>
      <label className="label block" htmlFor={`${id}-widget`}>
        {itemKind} anpassen
      </label>
      <select
        id={`${id}-widget`}
        className="input w-full min-w-0 max-w-full"
        value={selected.id}
        disabled={disabled}
        onChange={(event) => setSelectedId(event.target.value)}
        aria-describedby={`${id}-help`}
      >
        {widgets.map((widget) => (
          <option key={widget.id} value={widget.id}>
            {widget.label}
          </option>
        ))}
      </select>
      <WidgetGeometryForm
        key={selected.id}
        widget={selected}
        disabled={disabled}
        itemKind={itemKind}
        removeDisabled={removeDisabled}
        onApply={onApply}
        onRemove={onRemove}
      />
    </section>
  );
}

function WidgetGeometryForm({
  widget,
  disabled,
  itemKind,
  removeDisabled,
  onApply,
  onRemove,
}: Omit<GridLayoutControlsProps, 'widgets'> & { widget: GridControlItem }) {
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const limits = widget;
  const name = widget.label;

  // Update the drafts after applying/dragging, without remounting the focused
  // input or submit button. Unrelated renders do not discard typed values.
  useEffect(() => {
    formRef.current?.reset();
  }, [widget.x, widget.y, widget.w, widget.h]);

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const data = new FormData(event.currentTarget);
    onApply(widget.id, {
      x: Number(data.get('column')) - 1,
      y: Number(data.get('row')) - 1,
      w: Number(data.get('width')),
      h: Number(data.get('height')),
    });
  }

  return (
    <form
      ref={formRef}
      onSubmit={apply}
      aria-label={`${name}: Position und Größe`}
      // This form applies a local layout draft and owns its autosave. The
      // settings-wide guard must not hide its button or submit it implicitly.
      data-settings-no-track
    >
      <p className="mb-3 text-sm text-secondary" id={`${id}-current`}>
        Aktuell: {gridGeometryDescription(widget)}.
      </p>
      <fieldset disabled={disabled} aria-describedby={`${id}-current`}>
        <legend className="sr-only">Position und Größe für {name}</legend>
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <GeometryInput
            id={`${id}-column`}
            name="column"
            label="Startspalte"
            value={widget.x + 1}
            min={1}
            max={GRID_COLUMNS - limits.minW + 1}
          />
          <GeometryInput
            id={`${id}-row`}
            name="row"
            label="Startzeile"
            value={widget.y + 1}
            min={1}
            max={GRID_MAX_Y + 1}
          />
          <GeometryInput
            id={`${id}-width`}
            name="width"
            label="Breite (Spalten)"
            value={widget.w}
            min={limits.minW}
            max={GRID_COLUMNS}
          />
          <GeometryInput
            id={`${id}-height`}
            name="height"
            label="Höhe (Rasterzeilen)"
            value={widget.h}
            min={limits.minH}
            max={GRID_MAX_HEIGHT}
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="submit" className="btn-primary text-sm">
            Übernehmen
          </button>
          <button type="reset" className="btn-secondary text-sm">
            Eingaben zurücksetzen
          </button>
          <button
            type="button"
            className="btn-secondary text-sm"
            onClick={() => onRemove(widget.id)}
            disabled={removeDisabled}
          >
            {itemKind} entfernen: {name}
          </button>
          {removeDisabled && (
            <p className="text-sm text-secondary">Mindestens ein Block muss erhalten bleiben.</p>
          )}
        </div>
      </fieldset>
    </form>
  );
}

function GeometryInput({
  id,
  name,
  label,
  value,
  min,
  max,
}: {
  id: string;
  name: string;
  label: string;
  value: number;
  min: number;
  max: number;
}) {
  return (
    <div className="min-w-0">
      <label className="label block" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        name={name}
        type="number"
        inputMode="numeric"
        className="input w-full min-w-0"
        defaultValue={value}
        min={min}
        max={max}
        step={1}
        required
      />
      <p className="mt-1 text-sm text-muted">
        {min} bis {max}
      </p>
    </div>
  );
}
