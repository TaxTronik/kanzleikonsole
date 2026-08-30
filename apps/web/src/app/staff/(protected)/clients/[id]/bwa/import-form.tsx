'use client';

import { useState, useTransition, type SubmitEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Upload } from 'lucide-react';
import { importAddisonCsvAction, importDatevXlsxAction, type ImportResult } from './actions';

type Source = 'ADDISON' | 'DATEV';

export function BwaImportForm({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [source, setSource] = useState<Source>('ADDISON');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const accept =
    source === 'ADDISON'
      ? '.csv,text/csv'
      : '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const hint =
    source === 'ADDISON'
      ? 'Addison-CSV mit Semikolon, deutsche Dezimalkommas, z. B. a<MandantenNr>.csv'
      : 'DATEV-XLSX-Vorjahresvergleich, z. B. <Berater>_<Mandant>_<Jahr>_Vorjahresvergleich.xlsx';

  function handleSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setResult(null);
    if (!file) {
      setError('Bitte Datei auswählen.');
      return;
    }

    startTransition(async () => {
      try {
        let r: ImportResult;
        if (source === 'ADDISON') {
          const text = await file.text();
          r = await importAddisonCsvAction({
            clientId,
            fileName: file.name,
            csv: text,
          });
        } else {
          const arrayBuffer = await file.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i] as number);
          }
          const xlsxBase64 = btoa(binary);
          r = await importDatevXlsxAction({
            clientId,
            fileName: file.name,
            xlsxBase64,
          });
        }
        setResult(r);
        if (r.error) setError(r.error);
        else router.refresh();
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="flex gap-2 mb-3">
        {(['ADDISON', 'DATEV'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setSource(s);
              setFile(null);
              setResult(null);
              setError(null);
            }}
            className={
              source === s
                ? 'px-3 py-1.5 text-xs rounded-md bg-brand-600 text-on-brand font-medium'
                : 'px-3 py-1.5 text-xs rounded-md bg-gray-100 text-secondary hover:bg-gray-200'
            }
          >
            {s === 'ADDISON' ? 'Addison-CSV' : 'DATEV-XLSX'}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
        <div>
          <label className="label" htmlFor="bwa-file">
            {source === 'ADDISON' ? 'Addison-CSV' : 'DATEV-XLSX (Vorjahresvergleich)'}
          </label>
          <input
            id="bwa-file"
            type="file"
            accept={accept}
            className="input"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            required
          />
        </div>
        <button type="submit" className="btn-primary" disabled={isPending || !file}>
          <Upload className="h-3.5 w-3.5" />
          {isPending ? 'Verarbeitet…' : 'Importieren'}
        </button>
      </div>
      {/* Hinweis unter das Raster statt in die linke Spalte: dort zaehlte er zur
          Spaltenhoehe, und `items-end` schob den Button um genau seine Hoehe
          unter das Eingabefeld. */}
      <p className="text-xs text-muted">{hint}</p>

      {error && <div className="alert-error-sm">{error}</div>}
      {result?.ok && (
        <div className="alert-success-sm">
          {result.imported} Periode{result.imported === 1 ? '' : 'n'} importiert
          {result.skipped ? `, ${result.skipped} übersprungen (bereits vorhanden)` : ''}.
        </div>
      )}
      {result?.warnings && result.warnings.length > 0 && (
        <div className="rounded-md bg-yellow-50 p-3 text-xs text-yellow-800">
          {result.warnings.map((w, i) => (
            <p key={i}>· {w}</p>
          ))}
        </div>
      )}
    </form>
  );
}
