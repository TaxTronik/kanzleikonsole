import { ShieldCheck, ShieldAlert } from 'lucide-react';
import type { PersistedRecoveryCheckpoint, PersistedVerifyResult } from '@taxtronik/evidence';
import { fmtDateTimeSeconds } from '@/lib/fmt';
import { auditDisplayStatus } from '@/server/audit/status';
import { createAuditRecoveryCheckpointAction, triggerAuditVerifyAction } from './actions';

type ChainStatus = ReturnType<typeof auditDisplayStatus>;
const statusClasses: Record<ChainStatus, string> = {
  none: 'rounded-md border border-default bg-gray-50 p-4 mb-6 dark:bg-gray-900/60',
  ok: 'rounded-md border border-green-200 bg-green-50 p-4 mb-6 dark:border-green-800 dark:bg-green-950/50',
  amber:
    'rounded-md border border-yellow-200 bg-yellow-50 p-4 mb-6 dark:border-yellow-800 dark:bg-yellow-950/50',
  red: 'rounded-md border border-red-200 bg-red-50 p-4 mb-6 dark:border-red-800 dark:bg-red-950/50',
};
const iconClasses: Record<ChainStatus, string> = {
  none: 'h-5 w-5 text-disabled mt-0.5',
  ok: 'h-5 w-5 text-green-600 mt-0.5',
  amber: 'h-5 w-5 text-yellow-600 mt-0.5',
  red: 'h-5 w-5 text-red-600 mt-0.5',
};

export function AuditChainStatusCard({
  verifyResult,
  checkpoint,
  pollVerify,
  checkpointCreated,
}: {
  verifyResult: PersistedVerifyResult | null;
  checkpoint: PersistedRecoveryCheckpoint | null;
  pollVerify: boolean;
  checkpointCreated: boolean;
}) {
  const status = auditDisplayStatus(verifyResult, checkpoint);
  const Icon = status === 'ok' ? ShieldCheck : ShieldAlert;
  return (
    <div className={statusClasses[status]}>
      <div className="flex items-start gap-3">
        <Icon className={iconClasses[status]} />
        <div className="flex-1">
          <ChainResult status={status} verifyResult={verifyResult} checkpoint={checkpoint} />
          {pollVerify && (
            <p className="text-xs text-primary mt-2">
              Prüfung angestoßen — das Ergebnis erscheint hier, sobald der Hintergrund-Job
              abgeschlossen ist.
            </p>
          )}
          {checkpointCreated && (
            <p className="text-xs text-secondary mt-2">Recovery-Checkpoint angelegt.</p>
          )}
        </div>
        <form action={triggerAuditVerifyAction}>
          <button type="submit" className="btn-secondary text-xs shrink-0">
            Jetzt prüfen
          </button>
        </form>
      </div>
    </div>
  );
}

function ChainResult({
  status,
  verifyResult,
  checkpoint,
}: {
  status: ChainStatus;
  verifyResult: PersistedVerifyResult | null;
  checkpoint: PersistedRecoveryCheckpoint | null;
}) {
  if (!verifyResult)
    return (
      <p className="text-sm text-secondary">
        Noch kein Prüfergebnis — der tägliche Integritäts-Job ist noch nicht gelaufen. „Jetzt
        prüfen" stößt eine Verifikation an.
      </p>
    );
  if (status === 'ok') return <HealthyChainResult verifyResult={verifyResult} />;
  if (status === 'amber')
    return <RecoveredChainResult verifyResult={verifyResult} checkpoint={checkpoint} />;
  return <BrokenChainResult verifyResult={verifyResult} />;
}

function verifiedRollingAnchorCount(result: PersistedVerifyResult): number {
  return result.anchorsChecked ?? 0;
}

function brokenRollingAnchorCount(result: PersistedVerifyResult): number {
  return result.anchorBreaks ?? 0;
}

function RollingAnchorBreakSummary({ result }: { result: PersistedVerifyResult }) {
  const broken = brokenRollingAnchorCount(result);
  if (broken === 0) return null;
  return (
    <p className="text-xs text-red-700 mt-1 dark:text-red-200">
      {broken} externe Rolling-Verankerung(en) mit Integritätsproblem
    </p>
  );
}

function HealthyChainResult({ verifyResult }: { verifyResult: PersistedVerifyResult }) {
  return (
    <>
      <p className="text-sm font-medium text-green-900 dark:text-green-100">
        Hash-Chain intakt — {verifyResult.checked.toLocaleString('de-DE')} Einträge geprüft
      </p>
      <p className="text-xs text-green-700 mt-1 dark:text-green-200">
        {verifyResult.sealsChecked} Tagesversiegelungen geprüft
        {' · '}
        {verifiedRollingAnchorCount(verifyResult)} Rolling-Anker geprüft
        {' · '}zuletzt geprüft {fmtDateTimeSeconds(new Date(verifyResult.checkedAt))}
      </p>
      {verifyResult.tsaMode === 'local' && (
        <p className="text-xs text-amber-700 mt-1 dark:text-amber-200">
          ⚠ Zeitstempel-Modus: lokal — keine externe TSA. Der Seal-Check ist gegenstandslos; nur die
          SHA-256-Kette trägt. Für revisionssichere externe Verankerung eine RFC-3161-TSA
          konfigurieren.
        </p>
      )}
      {verifyResult.tsaMode === 'rfc3161' && (
        <p
          className={
            'text-xs mt-1 ' +
            (verifyResult.sealsChecked > 0 &&
            (verifyResult.sealsTrustAnchored ?? 0) < verifyResult.sealsChecked
              ? 'text-amber-700 dark:text-amber-200'
              : 'text-green-700 dark:text-green-200')
          }
        >
          Zeitstempel-Modus: externe TSA (RFC 3161).
          {verifyResult.sealsChecked > 0 && (
            <>
              {' '}
              Trust-verankert: {verifyResult.sealsTrustAnchored ?? 0}/{verifyResult.sealsChecked}.
              {(verifyResult.sealsTrustAnchored ?? 0) < verifyResult.sealsChecked && (
                <> Übrige ungültig — passenden Produktiv-TSA-Root hinterlegen.</>
              )}
            </>
          )}
        </p>
      )}
    </>
  );
}

function RecoveredChainResult({
  verifyResult,
  checkpoint,
}: {
  verifyResult: PersistedVerifyResult;
  checkpoint: PersistedRecoveryCheckpoint | null;
}) {
  return (
    <>
      <p className="text-sm font-medium text-yellow-900 dark:text-yellow-100">
        Historischer Chain-Befund — Recovery-Checkpoint dokumentiert
      </p>
      {verifyResult.firstBreak && (
        <p className="text-xs text-yellow-800 mt-1 font-mono dark:text-yellow-100">
          Befund bei Audit-ID {verifyResult.firstBreak.auditId} (
          {fmtDateTimeSeconds(new Date(verifyResult.firstBreak.occurredAt))}) — historisch, durch
          Checkpoint abgegrenzt.
        </p>
      )}
      {checkpoint && (
        <p className="text-xs text-yellow-800 mt-1 dark:text-yellow-100">
          Recovery-Checkpoint ab Audit-ID {checkpoint.auditId} gesetzt — der historische Bruch
          bleibt abgegrenzt.
        </p>
      )}
      <p className="text-xs text-yellow-700 mt-1 dark:text-yellow-200">
        Zuletzt geprüft {fmtDateTimeSeconds(new Date(verifyResult.checkedAt))}
      </p>
    </>
  );
}

function BrokenChainResult({ verifyResult }: { verifyResult: PersistedVerifyResult }) {
  return (
    <>
      <p className="text-sm font-medium text-red-900 dark:text-red-100">
        {verifyResult.error ? 'Verifikation fehlgeschlagen.' : '⚠ Hash-Chain gebrochen!'}
      </p>
      {verifyResult.firstBreak && (
        <p className="text-xs text-red-700 mt-1 font-mono dark:text-red-200">
          Erster Bruch bei Audit-ID {verifyResult.firstBreak.auditId} (
          {fmtDateTimeSeconds(new Date(verifyResult.firstBreak.occurredAt))})
        </p>
      )}
      {verifyResult.sealBreaks > 0 && (
        <p className="text-xs text-red-700 mt-1 dark:text-red-200">
          {verifyResult.sealBreaks} Tagesversiegelung(en) mit TSA-Problem
        </p>
      )}
      <RollingAnchorBreakSummary result={verifyResult} />
      {(verifyResult.policyBreaks ?? []).map((b) => (
        <p key={b} className="text-xs text-red-700 mt-1 dark:text-red-200">
          {b}
        </p>
      ))}
      {verifyResult.error && (
        <p className="text-xs text-red-700 mt-1 dark:text-red-200">Fehler: {verifyResult.error}</p>
      )}
      <p className="text-xs text-red-700 mt-1 dark:text-red-200">
        Geprüft {fmtDateTimeSeconds(new Date(verifyResult.checkedAt))}
      </p>
      <RecoveryCheckpointForm />
    </>
  );
}

function RecoveryCheckpointForm() {
  return (
    <form
      action={createAuditRecoveryCheckpointAction}
      className="mt-3 rounded-md border border-red-300 bg-white/70 p-3 dark:border-red-800 dark:bg-red-950/60"
    >
      <p className="text-xs font-medium text-red-900 dark:text-red-100">Wiederaufnahme markieren</p>
      <p className="text-xs text-red-700 mt-1 dark:text-red-200">
        Legt einen Recovery-Checkpoint an: das historische Rot wird damit bernstein abgegrenzt und
        die Break-Benachrichtigung verstummt.
      </p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          name="reason"
          className="input text-xs sm:flex-1"
          maxLength={500}
          placeholder="Begründung, z. B. TSA-Fehlkonfiguration behoben"
        />
        <button type="submit" className="btn-primary !bg-red-600 text-xs hover:!bg-red-700">
          Recovery-Checkpoint anlegen
        </button>
      </div>
    </form>
  );
}
