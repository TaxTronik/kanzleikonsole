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
