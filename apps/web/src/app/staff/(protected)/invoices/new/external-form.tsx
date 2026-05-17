'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Upload, FileText, Send } from 'lucide-react';
import { uploadExternalInvoiceAction } from '../actions';

interface ClientOption { id: string; name: string; }
interface CategoryOption { id: string; name: string; }

export function ExternalInvoiceForm({
  clients,
  categories,
  suggestedNumber,
}: {
  clients: ClientOption[];
  categories: CategoryOption[];
  suggestedNumber: string;
}) {
  const router = useRouter();
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function readBase64(f: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve((r.result as string).split(',')[1] ?? '');
      r.onerror = () => reject(r.error);
      r.readAsDataURL(f);
    });
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError('Bitte eine PDF-Datei auswählen.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('PDF zu groß (max. 10 MB).');
      return;
    }
    const fd = new FormData(e.currentTarget);
    start(async () => {
      const base64 = await readBase64(file);
      const res = await uploadExternalInvoiceAction({
        clientId: String(fd.get('clientId') ?? ''),
        categoryId: String(fd.get('categoryId') ?? '') || null,
        number: String(fd.get('number') ?? ''),
        issueDate: String(fd.get('issueDate') ?? ''),
        dueDate: String(fd.get('dueDate') ?? ''),
        totalAmount: Number(fd.get('totalAmount') ?? 0),
        subject: String(fd.get('subject') ?? ''),
        notes: String(fd.get('notes') ?? '') || null,
        pdf: { fileName: file.name, mimeType: file.type || 'application/pdf', base64 },
      });
      if (!res.ok) {
        setError(res.error ?? 'Upload fehlgeschlagen.');
        return;
      }
      router.push(`/staff/invoices/${res.id}`);
    });
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const dueIso = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d.toISOString().slice(0, 10);
  })();

  return (
    <form onSubmit={submit} className="card p-6 space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label" htmlFor="clientId">Mandant <span className="text-red-600">*</span></label>
          <select id="clientId" name="clientId" required className="input">
            <option value="">— wählen —</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="categoryId">Rechnungstyp</label>
          <select id="categoryId" name="categoryId" className="input" defaultValue="">
            <option value="">— ohne Typ —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="label" htmlFor="number">Rechnungsnummer <span className="text-red-600">*</span></label>
          <input
            id="number" name="number" type="text" required maxLength={50}
            defaultValue={suggestedNumber}
            className="input font-mono"
          />
        </div>
        <div>
          <label className="label" htmlFor="issueDate">Rechnungsdatum <span className="text-red-600">*</span></label>
          <input id="issueDate" name="issueDate" type="date" required defaultValue={todayIso} className="input" />
        </div>
        <div>
          <label className="label" htmlFor="dueDate">Fällig am <span className="text-red-600">*</span></label>
          <input id="dueDate" name="dueDate" type="date" required defaultValue={dueIso} className="input" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label" htmlFor="totalAmount">Betrag (Brutto, €) <span className="text-red-600">*</span></label>
          <input
            id="totalAmount" name="totalAmount" type="number" step="0.01" min="0" required
            className="input font-mono"
            placeholder="0,00"
          />
        </div>
        <div>
          <label className="label" htmlFor="subject">Betreff <span className="text-red-600">*</span></label>
          <input id="subject" name="subject" type="text" required maxLength={200}
            className="input"
            placeholder='z. B. „Honorar März 2026"'
          />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="pdf">PDF-Datei <span className="text-red-600">*</span></label>
        <input
          ref={fileInputRef}
          id="pdf" name="pdf" type="file" accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="input"
        />
        {file && (
          <p className="text-xs text-gray-500 mt-1 inline-flex items-center gap-1">
            <FileText className="h-3.5 w-3.5" />
            {file.name} · {(file.size / 1024).toFixed(0)} KB
          </p>
        )}
      </div>

      <div>
        <label className="label" htmlFor="notes">Interne Notiz (optional)</label>
        <textarea id="notes" name="notes" rows={2} maxLength={1000} className="input" />
      </div>

      <p className="text-xs text-gray-500">
        Die PDF wird mit Object-Lock COMPLIANCE (10 Jahre, GoBD) abgelegt und
        landet im Mandanten-Portal unter „Rechnungen". Zusätzlich erhält der
        Mandant eine Mail mit der PDF als Anhang — der Begleittext kommt aus
        der dem Rechnungstyp zugeordneten Mail-Vorlage (oder dem Standard).
      </p>

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button type="submit" disabled={isPending || !file} className="btn-primary inline-flex items-center gap-1.5">
          {isPending ? (
            <>
              <Upload className="h-4 w-4 animate-pulse" />
              Lade hoch + sende…
            </>
          ) : (
            <>
              <Send className="h-4 w-4" />
              Rechnung speichern + an Mandant senden
            </>
          )}
        </button>
      </div>
    </form>
  );
}
