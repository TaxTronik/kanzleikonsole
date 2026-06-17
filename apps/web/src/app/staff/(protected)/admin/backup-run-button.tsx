'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Play } from 'lucide-react';

export function BackupRunButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/staff/admin/backups/run', {
        method: 'POST',
        headers: { accept: 'application/json' },
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) {
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="btn-primary text-xs py-1.5 inline-flex items-center gap-1.5 disabled:opacity-60"
      >
        <Play className="h-3.5 w-3.5" />
        {pending ? 'Backup läuft' : 'Backup starten'}
      </button>
      {error && <p className="text-xs text-red-700 mt-2 truncate">{error}</p>}
    </div>
  );
}
