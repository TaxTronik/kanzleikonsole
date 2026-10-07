'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Play } from 'lucide-react';

// P-22: Der Button reiht den Worker-Job backup-run nur ein (202) und fragt den
// gespeicherten Zustand ab; kein HTTP-Request wartet mehr auf pg_dump/Upload.
// B12: Der Job streamt den Dump direkt in den Backup-Bucket; eine lokale Kopie
// unter backups/ entsteht nur mit `./taxtronik backup` auf dem Server. Der
// Hinweis unter dem Button sagt das, damit niemand eine Kopie dort erwartet.
const POLL_INTERVAL_MS = 3_000;
const POLL_LIMIT_MS = 2 * 60 * 60 * 1000;
const PENDING = new Set(['waiting', 'delayed', 'prioritized', 'waiting-children', 'active']);

type Phase = 'idle' | 'starting' | 'queued' | 'running';

interface StatusBody {
  job: string | null;
  latest: { status: string; startedAt: string } | null;
  error?: string;
}

const ERRORS: Record<string, string> = {
  backup_already_running: 'Es läuft bereits ein Backup.',
  backup_scope_not_allowed: 'Browser-Backups sind nur in Single-Tenant-Installationen möglich.',
  rate_limited: 'Zu viele Versuche. Bitte später erneut starten.',
};

export function BackupRunButton() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintId = useId();

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function poll(startedPolling: number) {
    let body: StatusBody;
    try {
      const res = await fetch('/api/staff/admin/backups/run', {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      body = (await res.json()) as StatusBody;
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    } catch {
      body = { job: 'unknown', latest: null };
    }
    if (body.job !== null && PENDING.has(body.job)) {
      setPhase(body.job === 'active' ? 'running' : 'queued');
      if (Date.now() - startedPolling < POLL_LIMIT_MS) {
        timer.current = setTimeout(() => void poll(startedPolling), POLL_INTERVAL_MS);
      } else {
        setPhase('idle');
        setMessage('Status unbekannt — bitte die Seite später neu laden.');
      }
      return;
    }
    if (body.job === 'unknown' && Date.now() - startedPolling < POLL_LIMIT_MS) {
      timer.current = setTimeout(() => void poll(startedPolling), POLL_INTERVAL_MS);
      return;
    }
    setPhase('idle');
    if (body.job === 'failed' || body.latest?.status === 'FAILED') {
      setError('Backup fehlgeschlagen — Details in der Backup-Übersicht.');
    } else {
      setMessage('Backup abgeschlossen.');
    }
    router.refresh();
  }

  async function run() {
    setPhase('starting');
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/staff/admin/backups/run', {
        method: 'POST',
        headers: { accept: 'application/json' },
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) {
        const code = body.error ?? `HTTP ${res.status}`;
        throw new Error(ERRORS[code] ?? body.message ?? code);
      }
      setPhase('queued');
      timer.current = setTimeout(() => void poll(Date.now()), POLL_INTERVAL_MS);
    } catch (e) {
      setPhase('idle');
      setError((e as Error).message);
    }
  }

  const busy = phase !== 'idle';
  const label =
    phase === 'running'
      ? 'Backup läuft'
      : phase === 'queued' || phase === 'starting'
        ? 'Backup eingereiht'
        : 'Backup starten';

  return (
    <div>
      <button
        type="button"
        onClick={run}
        disabled={busy}
        aria-describedby={hintId}
        className="btn-primary text-xs py-1.5 inline-flex items-center gap-1.5 disabled:opacity-60"
      >
        <Play className="h-3.5 w-3.5" />
        {label}
      </button>
      <p id={hintId} className="text-xs text-muted mt-2">
        Reiht den Backup-Job des Workers ein: Er sichert die Datenbank direkt in den Backup-Bucket
        (S3), ohne lokale Kopie auf dem Server. Eine lokale Kopie unter <code>backups/</code>{' '}
        erstellt der Betreiber auf dem Server mit <code>./taxtronik backup</code>.
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {busy ? label : (message ?? '')}
      </p>
      {message && !busy && <p className="text-xs text-secondary mt-2">{message}</p>}
      {error && <p className="text-xs text-red-700 mt-2 truncate">{error}</p>}
    </div>
  );
}
