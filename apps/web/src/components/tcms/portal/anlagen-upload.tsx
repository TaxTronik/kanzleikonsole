'use client';

// =============================================================================
// Dateien für das Tax-CMS im Portal auswählen und hochladen (TCMS Stufe 3,
// Bereich D; aus der Demo components/durchfuehrung/formulare.tsx,
// UploadFormular). Vorprüfung im Browser nur zur Bedienung (Anzahl, Größe);
// verbindlich prüfen die Aktion, die Dokumentenpipeline der kanzleikonsole
// (Virenscan, Dateityp nach Inhalt) und das Tax-CMS. Nach Erfolg wird die
// Auswahl geleert.
// =============================================================================

import { useId, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { TcmsErgebnisMeldung, useTcmsAbsenden, type TcmsFormAktion } from '../ereignisse/aktionen';
import { groesseText } from './werte';

/** Problem einer Auswahl für die Anzeige (oder null). */
export function auswahlProblem(
  dateien: ReadonlyArray<{ name: string; size: number }>,
  grenzen: { maxDateien: number; maxBytes: number; maxGesamt: number },
): string | null {
  if (dateien.length > grenzen.maxDateien) {
    return `Bitte höchstens ${grenzen.maxDateien} Dateien auf einmal hochladen.`;
  }
  const zuGross = dateien.filter((d) => d.size > grenzen.maxBytes);
  if (zuGross.length) {
    return `Höchstens ${groesseText(grenzen.maxBytes)} je Datei: ${zuGross.map((d) => d.name).join(', ')}`;
  }
  if (dateien.some((d) => d.size === 0)) return 'Eine Datei ist leer.';
  if (dateien.reduce((summe, d) => summe + d.size, 0) > grenzen.maxGesamt) {
    return `Zusammen höchstens ${groesseText(grenzen.maxGesamt)} auf einmal – bitte in mehreren Schritten hochladen.`;
  }
  return null;
}

export function AnlagenUpload({
  aktion,
  maxDateien,
  maxBytes,
  maxGesamt,
  accept,
  hinweis,
}: {
  aktion: TcmsFormAktion;
  maxDateien: number;
  maxBytes: number;
  /** Alle Dateien eines Aufrufs zusammen (Body-Limit der Server-Actions). */
  maxGesamt: number;
  accept: string;
  hinweis: string;
}) {
  const id = useId();
  const eingabe = useRef<HTMLInputElement>(null);
  const [auswahl, setAuswahl] = useState<Array<{ name: string; size: number }>>([]);
  const { ergebnis, laeuft, onSubmit } = useTcmsAbsenden(async (vorher, formData) => {
    const r = await aktion(vorher, formData);
    if (r.ok) {
      if (eingabe.current) eingabe.current.value = '';
      setAuswahl([]);
    }
    return r;
  });
  const problem = auswahlProblem(auswahl, { maxDateien, maxBytes, maxGesamt });
  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <div className="rounded border border-dashed border-default p-4 text-center space-y-2">
        <Upload className="h-6 w-6 text-muted mx-auto" aria-hidden="true" />
        <label htmlFor={`${id}-dateien`} className="block text-sm font-medium text-secondary">
          Dateien auswählen
        </label>
        <input
          ref={eingabe}
          id={`${id}-dateien`}
          type="file"
          name="dateien"
          multiple
          accept={accept}
          className="mx-auto block text-sm"
          aria-describedby={`${id}-hinweis`}
          onChange={(e) =>
            setAuswahl(
              Array.from(e.target.files ?? []).map((f) => ({ name: f.name, size: f.size })),
            )
          }
        />
        <p id={`${id}-hinweis`} className="hint">
          {hinweis}. Nach dem Übermitteln werden die Dateien gesperrt; der SHA-256-Wert wird
          gespeichert.
        </p>
        {auswahl.length ? (
          <p className="text-xs text-secondary">
            {auswahl.map((d) => `${d.name} (${groesseText(d.size)})`).join(' · ')}
          </p>
        ) : null}
      </div>
      {problem ? (
        <p className="alert-error-sm" role="alert">
          {problem}
        </p>
      ) : (
        <TcmsErgebnisMeldung ergebnis={ergebnis} titel="Nicht hochgeladen." />
      )}
      <div className="form-actions">
        <button
          type="submit"
          className="btn-primary"
          disabled={laeuft || auswahl.length === 0 || problem !== null}
          aria-busy={laeuft}
        >
          <Upload className="h-4 w-4" aria-hidden="true" />{' '}
          {laeuft ? 'Wird hochgeladen …' : 'Hochladen'}
        </button>
      </div>
    </form>
  );
}
