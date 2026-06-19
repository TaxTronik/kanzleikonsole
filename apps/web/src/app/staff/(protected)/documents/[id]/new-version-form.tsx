'use client';

import { useState, useTransition, type SubmitEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Upload } from 'lucide-react';

interface Props {
  documentId: string;
}

export function NewVersionForm({ documentId }: Props) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [changeNote, setChangeNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<'idle' | 'presign' | 'upload' | 'commit'>('idle');
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError('Bitte Datei wählen.');
      return;
    }

    startTransition(async () => {
      try {
        // Ein POST: Datei + Felder als multipart, App streamt intern.
        setProgress('upload');
        const fd = new FormData();
        fd.set('file', file);
        fd.set('mimeType', file.type || 'application/octet-stream');
        if (changeNote) fd.set('changeNote', changeNote);

        setProgress('commit');
        const commitRes = await fetch(`/api/staff/documents/${documentId}/new-version/commit`, {
          method: 'POST',
          body: fd,
        });
        if (!commitRes.ok) {
          const body = await commitRes.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? 'Upload fehlgeschlagen');
        }

        setFile(null);
        setChangeNote('');
        setProgress('idle');
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
        setProgress('idle');
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="label" htmlFor="version-file">Datei</label>
        <input
          id="version-file"
          type="file"
          className="input"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          required
        />
      </div>
      <div>
        <label className="label" htmlFor="changeNote">Änderungs-Notiz (optional)</label>
        <input
          id="changeNote"
          type="text"
          className="input"
          value={changeNote}
          onChange={(e) => setChangeNote(e.target.value)}
          placeholder="z. B. „Korrektur Adresse"
          maxLength={500}
        />
      </div>
      {error && <div className="alert-error-sm">{error}</div>}
      {progress !== 'idle' && (
        <div className="alert-info-sm">
          {progress === 'presign' && 'Hochladevorbereitung…'}
          {progress === 'upload' && 'Datei wird hochgeladen…'}
          {progress === 'commit' && 'Virus-Scan & Verarbeitung…'}
        </div>
      )}
      <button type="submit" className="btn-primary" disabled={isPending || !file}>
        <Upload className="h-3.5 w-3.5" />
        {isPending ? 'Lädt…' : 'Neue Version hochladen'}
      </button>
    </form>
  );
}
