'use client';

import { useState, useTransition } from 'react';
import { UserX } from 'lucide-react';
import { confirmClientAnonymizationAction, confirmPoaSignerAnonymizationAction } from './actions';
import { confirmDialog } from '@/components/ui/modal';

export function ClientAnonymizeButton({
  clientId,
  label,
  disabledReason,
}: {
  clientId: string;
  label: string;
  /** z. B. „erst GwG-Belege vernichten" — Button bleibt dann inaktiv. */
  disabledReason?: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    const ok = await confirmDialog(
      `Mandanten-Stammdaten endgültig und unwiderruflich anonymisieren?\n\n${label}\n\n` +
        'Name, Adresse und Custom-Felder werden entfernt, verknüpfte Kontakte ' +
        'mit-anonymisiert. Ein Skelett-Datensatz (Vernichtungsvermerk) bleibt ' +
        'erhalten. Nur fortfahren, wenn alle gesetzlichen Aufbewahrungsfristen ' +
        '(insbesondere Handakte § 66 StBerG sowie dokumentartabhängige GoBD-/GwG-Fristen) abgelaufen sind.',
      { title: 'Mandant anonymisieren', confirmLabel: 'Endgültig anonymisieren', danger: true },
    );
    if (!ok) return;
    setError(null);
    start(async () => {
      const r = await confirmClientAnonymizationAction({ clientId });
      if (!r.ok) setError(r.error ?? 'Fehler bei der Anonymisierung.');
    });
  }

  if (disabledReason) {
    return <span className="text-xs text-muted">{disabledReason}</span>;
  }

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <button
        onClick={onClick}
        disabled={pending}
        className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
      >
        <UserX className="h-3.5 w-3.5" />
        {pending ? 'Anonymisiere…' : 'Anonymisieren'}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

export function PoaSignerAnonymizeButton({
  clientId,
  label,
  poas,
}: {
  clientId: string;
  label: string;
  poas: number;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    const ok = await confirmDialog(
      `Personendaten aus ${poas} Vollmacht${poas === 1 ? '' : 'en'} unwiderruflich redigieren?\n\n${label}\n\n` +
        'Die Gesellschaft bleibt als Mandant vollständig erhalten. Entfernt werden nur ' +
        'Unterzeichner-, Versand-Snapshot- und Signaturmetadaten, deren längste ' +
        'Aufbewahrungsfrist abgelaufen ist.',
      { title: 'Vollmachtsdaten redigieren', confirmLabel: 'Endgültig redigieren', danger: true },
    );
    if (!ok) return;
    setError(null);
    start(async () => {
      const r = await confirmPoaSignerAnonymizationAction({ clientId });
      if (!r.ok) setError(r.error ?? 'Fehler bei der PoA-Redaktion.');
    });
  }

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <button
        onClick={onClick}
        disabled={pending}
        className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
      >
        <UserX className="h-3.5 w-3.5" />
        {pending ? 'Redigiere…' : 'PoA-Daten redigieren'}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
