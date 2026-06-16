// =============================================================================
// Persistiertes Verifikations-Ergebnis (tenant_setting `audit_verify_result`).
//
// Der tägliche Worker-Job (apps/worker/src/jobs/audit-verify-check.ts) rechnet
// die Hash-Chain nach und legt das Ergebnis hier ab; die Admin-Audit-Seite
// zeigt NUR dieses persistierte Ergebnis, statt bei jedem Seitenaufruf die
// komplette Chain zu hashen (Sekunden bei 200k Einträgen, P2028 ab ~500k).
// =============================================================================

import type { VerificationResult } from './service';

/** tenant_setting-Key, unter dem das letzte Prüf-Ergebnis liegt. */
export const AUDIT_VERIFY_RESULT_SETTING_KEY = 'audit_verify_result';

/** tenant_setting-Key für den bewusst gesetzten Recovery-Checkpoint. */
export const AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY = 'audit_recovery_checkpoint';

export interface PersistedVerifyResult {
  /** Zeitpunkt des Prüf-Laufs (ISO-8601). */
  checkedAt: string;
  ok: boolean;
  checked: number;
  sealsChecked: number;
  /** Anzahl Tagesversiegelungen mit TSA-Problem. */
  sealBreaks: number;
  policyBreaks: string[];
  firstBreak: { auditId: string; occurredAt: string } | null;
  /** Gesetzt, wenn der Lauf selbst fehlschlug (Exception statt Ketten-Bruch). */
  error: string | null;
}

export interface PersistedRecoveryCheckpoint {
  auditId: string;
  createdAt: string;
  createdBy: string;
  reason: string | null;
  firstBreak: { auditId: string; occurredAt: string } | null;
  trustedPrevHash: string;
  trustedThisHash: string;
}

// -----------------------------------------------------------------------------
// Restore-Drill-Ergebnis (tenant_setting `backup_drill_result`).
//
// Der monatliche Worker-Job (apps/worker/src/jobs/backup-drill.ts) spielt das
// letzte erfolgreiche Backup in eine Wegwerf-DB ein und verifiziert die
// Audit-Hash-Chain auf dem WIEDERHERGESTELLTEN Stand — der beweisbare
// Wirksamkeitsnachweis der Sicherung (Art. 32 Abs. 1 lit. d DSGVO, GoBD).
// Liegt hier neben dem Audit-Verify-Ergebnis, weil derselbe Konsument-Split
// gilt: Worker schreibt, Admin-Seite liest nur das persistierte Ergebnis.
// -----------------------------------------------------------------------------

/** tenant_setting-Key, unter dem das letzte Drill-Ergebnis liegt. */
export const BACKUP_DRILL_RESULT_SETTING_KEY = 'backup_drill_result';

export interface PersistedDrillResult {
  /** Zeitpunkt des Drill-Laufs (ISO-8601). */
  checkedAt: string;
  ok: boolean;
  /** Objekt-Key des eingespielten Backups (null, wenn keins vorhanden war). */
  backupKey: string | null;
  /** Erstellzeitpunkt des eingespielten Backups (ISO-8601). */
  backupFinishedAt: string | null;
  /** Geprüfte Audit-Einträge auf der wiederhergestellten DB. */
  auditChecked: number;
  /** Gesetzt, wenn der Drill fehlschlug (Restore-/Chain-/Lauf-Fehler). */
  error: string | null;
}

export function toPersistedVerifyResult(
  r: VerificationResult,
  checkedAt: Date,
): PersistedVerifyResult {
  return {
    checkedAt: checkedAt.toISOString(),
    ok: r.ok,
    checked: r.checked,
    sealsChecked: r.sealsChecked,
    sealBreaks: r.sealBreaks.length,
    policyBreaks: r.policyBreaks,
    firstBreak: r.firstBreak
      ? {
          auditId: String(r.firstBreak.auditId),
          occurredAt: r.firstBreak.occurredAt.toISOString(),
        }
      : null,
    error: null,
  };
}
