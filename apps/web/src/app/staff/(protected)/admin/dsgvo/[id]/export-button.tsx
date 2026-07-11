'use client';

import { useState, useTransition } from 'react';
import { Download } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { exportContactDataAction } from '../actions';

export function ExportContactButton({
  contactId,
  requestId,
  subjectName,
}: {
  contactId: string;
  requestId: string;
  subjectName: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const r = await exportContactDataAction(requestId, contactId);
      if (r.error || !r.serialized) {
        setError(r.error ?? 'Export fehlgeschlagen.');
        return;
      }
      // JSON als Datei zum Download
      const blob = new Blob([r.serialized], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dsgvo-auskunft-${subjectName.replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      router.refresh();
    });
  }

  return (
    <>
      <button type="button" onClick={handleClick} disabled={isPending} className="btn-primary">
        <Download className="h-4 w-4" />
        {isPending ? 'Exportiert…' : 'JSON-Auskunft generieren'}
      </button>
      {error && <p className="text-xs text-red-700 mt-2">{error}</p>}
    </>
  );
}
