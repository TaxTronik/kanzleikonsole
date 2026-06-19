'use client';

import { useState, useTransition, useRef, type SubmitEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Paperclip, X } from 'lucide-react';
import { addPortalResponseAction } from './actions';

export function PortalResponseForm({ requestId }: { requestId: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [message, setMessage] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<'idle' | 'upload' | 'commit' | 'response'>('idle');
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!message.trim()) {
      setError('Bitte eine Antwort eingeben.');
      return;
    }

    startTransition(async () => {
      try {
        let documentId: string | undefined;

        if (file) {
          // Ein POST: Datei + Felder als multipart, App streamt intern
          // zu SeaweedFS (kein presigned-direct, Object-Store nie public).
          setProgress('upload');
          const upFd = new FormData();
          upFd.set('file', file);
          upFd.set('title', file.name);
          upFd.set('mimeType', file.type || 'application/octet-stream');

          setProgress('commit');
          const commitRes = await fetch('/api/portal/documents/commit', {
            method: 'POST',
            body: upFd,
          });
          if (!commitRes.ok) {
            const body = await commitRes.json().catch(() => ({}));
            throw new Error((body as { error?: string }).error ?? 'Verarbeitung fehlgeschlagen.');
          }
          const commit = await commitRes.json();
          documentId = commit.documentId;
        }

        // 4. Antwort speichern
        setProgress('response');
        const fd = new FormData();
        fd.set('requestId', requestId);
        fd.set('message', message);
        if (documentId) fd.set('documentId', documentId);
        const r = await addPortalResponseAction(fd);
        if (r.error) throw new Error(r.error);

        formRef.current?.reset();
        setMessage('');
        setFile(null);
        setProgress('idle');
        router.refresh();
      } catch (err) {
        setError((err as Error).message);
        setProgress('idle');
      }
    });
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-3">
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={4}
        className="input"
        placeholder="Ihre Antwort an die Kanzlei…"
        required
        minLength={1}
        maxLength={5000}
      />

      <div>
        {file ? (
          <div className="flex items-center gap-2 text-sm text-secondary bg-gray-50 px-3 py-2 rounded-md">
            <Paperclip className="h-4 w-4 text-disabled" />
            <span className="flex-1 truncate">{file.name}</span>
            <button
              type="button"
              onClick={() => setFile(null)}
              className="text-disabled hover:text-secondary"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <label className="inline-flex items-center gap-2 text-sm text-brand-700 hover:text-brand-800 cursor-pointer">
            <Paperclip className="h-4 w-4" />
            Datei anhängen
            <input
              type="file"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
        )}
      </div>

      {error && <div className="alert-error-sm">{error}</div>}

      {progress !== 'idle' && (
        <div className="alert-info-sm">
          {progress === 'upload' && 'Datei wird hochgeladen…'}
          {progress === 'commit' && 'Virus-Scan läuft…'}
          {progress === 'response' && 'Antwort wird gespeichert…'}
        </div>
      )}

      <button type="submit" className="btn-primary" disabled={isPending}>
        {isPending ? 'Sendet…' : 'Antwort senden'}
      </button>
    </form>
  );
}
