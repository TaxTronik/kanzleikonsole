'use client';

import { useEffect, useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  DatabaseZap,
  Loader2,
  RefreshCw,
  Square,
} from 'lucide-react';
import type { EmbeddingStatusResponse } from '@taxtronik/risk-layer';
import { fmtDateTimeShort } from '@/lib/fmt';
import { ConfirmModal } from '@/components/ui/modal';
import { SectionCard } from '../section-card';
import {
  cancelSignalEmbeddingAction,
  triggerSignalEmbeddingAction,
  updateSignalEmbeddingScheduleAction,
  type SignalEmbeddingActionResult,
} from './signal-embedding-actions';
import {
  embeddingJobLabel,
  isActiveEmbeddingJob,
  presentEmbeddingCurrent,
  safeEmbeddingJobError,
} from './signal-embedding-presentation';

type ScheduleChoice = 'off' | 'weekly' | 'custom';

interface SignalEmbeddingCardProps {
  status: EmbeddingStatusResponse | null;
  statusUnavailable: boolean;
  operatorConfigured: boolean;
}

function formatTimestamp(value: string | null, empty: string): string {
  return value ? fmtDateTimeShort(new Date(value)) : empty;
}

export function SignalEmbeddingCard({
  status,
  statusUnavailable,
  operatorConfigured,
}: SignalEmbeddingCardProps) {
  return (
    <SectionCard
      title="Signal-Embedding"
      description="Globaler semantischer Index der Signal-Engine. Aktualisierungsplan und Laufstatus werden direkt in Signal verwaltet, nicht in den Kanzlei-Einstellungen gespeichert."
    >
      <div className="space-y-5">
        <EmbeddingNotices
          status={status}
          statusUnavailable={statusUnavailable}
          operatorConfigured={operatorConfigured}
        />
        {status && <EmbeddingStatusPanel status={status} />}
        <EmbeddingControls
          status={status}
          disabled={!operatorConfigured || statusUnavailable || status?.refresh_available !== true}
        />
      </div>
    </SectionCard>
  );
}

function EmbeddingNotices({
  status,
  statusUnavailable,
  operatorConfigured,
}: {
  status: EmbeddingStatusResponse | null;
  statusUnavailable: boolean;
  operatorConfigured: boolean;
}) {
  return (
    <>
      {statusUnavailable && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <AlertCircle className="h-4 w-4" /> Embedding-Status derzeit nicht verfügbar
          </span>
          <p className="mt-1">
            Prüfen Sie Erreichbarkeit und Konfiguration der Signal-Engine. Es werden keine
            technischen Fehlerdetails im Browser angezeigt.
          </p>
        </div>
      )}
      {!operatorConfigured && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-950 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100">
          Nur-Lese-Modus: Für manuelle Aktualisierungen und den Wochenplan muss der Betreiber
          <code className="mx-1">RISK_LAYER_OPERATOR_TOKEN</code> serverseitig setzen.
        </div>
      )}
      {operatorConfigured && status && !status.refresh_available && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <AlertCircle className="h-4 w-4" /> Embedding-Steuerung nicht betriebsbereit
          </span>
          <p className="mt-1">
            Signal kann derzeit keinen Index aufbauen. Prüfen Sie dort Graph, lokale
            Embedding-Runtime, Modell und das beschreibbare Status-Volume.
          </p>
        </div>
      )}
    </>
  );
}

function EmbeddingStatusPanel({ status }: { status: EmbeddingStatusResponse }) {
  const remoteJobActive = isActiveEmbeddingJob(status.job.state);
  const jobError = safeEmbeddingJobError(status.job.error);
  const current = presentEmbeddingCurrent(status.index.current);

  return (
    <>
      <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <StatusValue
          label="Index"
          value={status.index.active ? 'Aktiv' : 'Inaktiv'}
          positive={status.index.active}
        />
        <StatusValue label="Aktualität" value={current.label} positive={current.positive} />
        <StatusValue
          label="Letzter erfolgreicher Lauf"
          value={formatTimestamp(
            status.job.last_success,
            status.index.active ? 'Nicht protokolliert' : 'Noch kein erfolgreicher Lauf',
          )}
        />
        <StatusValue
          label="Nächster Check"
          value={formatTimestamp(status.schedule.next_run_at, 'Nicht geplant')}
        />
      </dl>

      <div className="grid gap-4 rounded-lg border border-default bg-surface-raised p-4 text-xs md:grid-cols-2">
        <div>
          <p className="inline-flex items-center gap-1.5 font-medium text-primary">
            <DatabaseZap className="h-4 w-4" /> Index-Stand
          </p>
          <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-muted">
            <dt>Input-Fingerprint</dt>
            <dd
              className="break-all font-mono text-primary"
              title={status.index.input_fingerprint ?? undefined}
            >
              {status.index.input_fingerprint ?? '—'}
            </dd>
            <dt>Graph-Fingerprint</dt>
            <dd
              className="break-all font-mono text-primary"
              title={status.index.fingerprint ?? undefined}
            >
              {status.index.fingerprint ?? '—'}
            </dd>
            <dt>Encoder</dt>
            <dd className="break-all text-primary">{status.index.encoder ?? '—'}</dd>
            <dt>Verarbeitung</dt>
            <dd className="break-all text-primary">
              {status.device
                ? status.device.startsWith('cuda')
                  ? `${status.device} · GPU${status.device === 'cuda' ? ' (ROCm/CUDA)' : ''}`
                  : `${status.device} · CPU`
                : 'Nicht gemeldet'}
            </dd>
            <dt>Revision</dt>
            <dd className="break-all text-primary">{status.index.revision ?? '—'}</dd>
          </dl>
        </div>
        <div>
          <p className="inline-flex items-center gap-1.5 font-medium text-primary">
            {remoteJobActive ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Clock3 className="h-4 w-4" />
            )}
            Jobstatus: {embeddingJobLabel(status.job.state)}
          </p>
          <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-muted">
            <dt>Angefordert</dt>
            <dd className="text-primary">{formatTimestamp(status.job.requested, '—')}</dd>
            <dt>Gestartet</dt>
            <dd className="text-primary">{formatTimestamp(status.job.started, '—')}</dd>
            <dt>Beendet</dt>
            <dd className="text-primary">{formatTimestamp(status.job.completed, '—')}</dd>
            <dt>Letzter Check</dt>
            <dd className="text-primary">
              {formatTimestamp(status.schedule.last_check_at, 'Noch nie')}
            </dd>
          </dl>
          {jobError && (
            <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
              {jobError}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function EmbeddingControls({
  status,
  disabled,
}: {
  status: EmbeddingStatusResponse | null;
  disabled: boolean;
}) {
  const schedule = status?.schedule ?? null;
  return (
    <div className="grid gap-5 border-t border-default pt-5 md:grid-cols-2">
      <ScheduleControls
        key={`${scheduleChoiceFor(schedule)}-${schedule?.interval_days ?? 0}`}
        schedule={schedule}
        disabled={disabled}
      />
      <RefreshControls job={status?.job ?? null} disabled={disabled} />
    </div>
  );
}

function scheduleChoiceFor(schedule: EmbeddingStatusResponse['schedule'] | null): ScheduleChoice {
  if (!schedule?.enabled) return 'off';
  return schedule.interval_days === 7 ? 'weekly' : 'custom';
}

function ScheduleControls({
  schedule,
  disabled,
}: {
  schedule: EmbeddingStatusResponse['schedule'] | null;
  disabled: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SignalEmbeddingActionResult | null>(null);
  const remoteChoice = scheduleChoiceFor(schedule);
  const [choice, setChoice] = useState<ScheduleChoice>(remoteChoice);

  function save(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (choice === 'custom') return;
    setResult(null);
    startTransition(async () => {
      const actionResult = await updateSignalEmbeddingScheduleAction(
        choice === 'weekly' ? { enabled: true, intervalDays: 7 } : { enabled: false },
      );
      setResult(actionResult);
      if (actionResult.ok) router.refresh();
    });
  }

  return (
    <form data-settings-no-track onSubmit={save} className="space-y-2">
      <label className="label" htmlFor="signal-embedding-schedule">
        Automatische Aktualisierung
      </label>
      <p className="text-xs text-muted">
        Bleibt nach Setup und Deploy aus. Bei Aktivierung prüft Signal den globalen Index im
        gewählten Intervall und aktualisiert ihn bei Bedarf.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id="signal-embedding-schedule"
          className="input max-w-xs"
          value={choice}
          onChange={(event) => setChoice(event.target.value as ScheduleChoice)}
          disabled={disabled || pending}
        >
          <option value="off">Aus</option>
          <option value="weekly">Wöchentlich (alle 7 Tage)</option>
          {remoteChoice === 'custom' && (
            <option value="custom" disabled>
              Aktiv: alle {schedule?.interval_days} Tage
            </option>
          )}
        </select>
        <button
          type="submit"
          className="btn-secondary"
          disabled={disabled || pending || choice === remoteChoice || choice === 'custom'}
        >
          {pending ? 'Speichere…' : 'Plan übernehmen'}
        </button>
      </div>
      <ActionFeedback result={result} />
    </form>
  );
}

function RefreshControls({
  job,
  disabled,
}: {
  job: EmbeddingStatusResponse['job'] | null;
  disabled: boolean;
}) {
  const router = useRouter();
  const [result, setResult] = useState<SignalEmbeddingActionResult | null>(null);
  const [confirmStartOpen, setConfirmStartOpen] = useState(false);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const remoteJobActive = job ? isActiveEmbeddingJob(job.state) : false;
  const polling = !disabled && remoteJobActive;

  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => router.refresh(), 2_500);
    return () => window.clearInterval(timer);
  }, [polling, router]);

  async function trigger(): Promise<{ ok: boolean; error?: string }> {
    setResult(null);
    const actionResult = await triggerSignalEmbeddingAction({ confirmed: true });
    setResult(actionResult);
    if (actionResult.ok) router.refresh();
    return actionResult;
  }

  async function cancel(): Promise<{ ok: boolean; error?: string }> {
    if (!job?.id) return { ok: false, error: 'Der aktive Job hat keine gültige Job-ID.' };
    setResult(null);
    const actionResult = await cancelSignalEmbeddingAction({ jobId: job.id });
    setResult(actionResult);
    if (actionResult.ok) router.refresh();
    return actionResult;
  }

  return (
    <form
      data-settings-no-track
      onSubmit={(event) => {
        event.preventDefault();
        setConfirmStartOpen(true);
      }}
    >
      <p className="label">Manuelle Aktualisierung</p>
      <p className="mb-2 text-xs text-muted">
        Erzwingt einen vollständigen Neuaufbau unabhängig vom aktuellen Fingerprint.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          className="btn-primary inline-flex items-center gap-1.5"
          disabled={disabled || polling}
        >
          {polling ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {polling ? 'Embedding wird aktualisiert…' : 'Embedding jetzt aktualisieren'}
        </button>
        {remoteJobActive && (
          <button
            type="button"
            className="btn-secondary inline-flex items-center gap-1.5"
            disabled={disabled || job?.state === 'cancelling'}
            onClick={() => setConfirmCancelOpen(true)}
          >
            {job?.state === 'cancelling' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Square className="h-4 w-4" />
            )}
            {job?.state === 'cancelling' ? 'Abbruch läuft…' : 'Aktualisierung stoppen'}
          </button>
        )}
      </div>
      <ActionFeedback result={result} />
      {confirmStartOpen && (
        <ConfirmModal
          title="Embedding vollständig neu aufbauen?"
          message={
            'Der Neuaufbau kann CPU und Arbeitsspeicher mehrere Minuten stark auslasten. Auf kleinen VPS können andere Dienste in dieser Zeit deutlich langsamer reagieren.\n\nStarten Sie ihn nur, wenn die zusätzliche Last jetzt vertretbar ist.'
          }
          confirmLabel="Neuaufbau starten"
          busyLabel="Wird gestartet…"
          danger
          onConfirm={trigger}
          onClose={() => setConfirmStartOpen(false)}
        />
      )}
      {confirmCancelOpen && (
        <ConfirmModal
          title="Embedding-Aktualisierung stoppen?"
          message="Signal bricht den noch nicht veröffentlichten Neuaufbau am nächsten sicheren Modell-Batch ab. Der bisherige aktive Index bleibt erhalten."
          confirmLabel="Abbruch anfordern"
          busyLabel="Abbruch wird angefordert…"
          onConfirm={cancel}
          onClose={() => setConfirmCancelOpen(false)}
        />
      )}
    </form>
  );
}

function StatusValue({
  label,
  value,
  positive,
}: {
  label: string;
  value: string;
  positive?: boolean;
}) {
  return (
    <div className="rounded-md border border-default px-3 py-2">
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd
        className={
          positive === undefined
            ? 'mt-1 text-sm font-medium text-primary'
            : positive
              ? 'mt-1 inline-flex items-center gap-1 text-sm font-medium text-emerald-700 dark:text-emerald-400'
              : 'mt-1 inline-flex items-center gap-1 text-sm font-medium text-amber-700 dark:text-amber-400'
        }
      >
        {positive === true && <CheckCircle2 className="h-4 w-4" />}
        {positive === false && <AlertCircle className="h-4 w-4" />}
        {value}
      </dd>
    </div>
  );
}

function ActionFeedback({ result }: { result: SignalEmbeddingActionResult | null }) {
  if (!result) return null;
  return (
    <p
      role="status"
      className={
        result.ok
          ? 'mt-2 inline-flex items-start gap-1.5 text-xs text-emerald-700 dark:text-emerald-400'
          : 'mt-2 inline-flex items-start gap-1.5 text-xs text-red-700 dark:text-red-400'
      }
    >
      {result.ok ? (
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      ) : (
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      )}
      {result.message ?? result.error}
    </p>
  );
}
