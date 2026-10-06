// =============================================================================
// Baseline zu server-action-style.test.ts (Review-Befund K-02).
//
// HANDWRITTEN_ACTION_BASELINE: Anzahl exportierter Actions je Datei, die noch
// ohne withStaff/withPortalContext bzw. staffAction/portalAction laufen, mit
// Begründung. Sinkt eine Zahl, wird sie hier abgesenkt; eine neue Datei mit
// handgeschriebenen Actions gehört nicht hierher, sondern auf einen Baustein.
//
// PUBLIC_ACTION_ENTRY_POINTS: Auth-Eintrittspunkte ohne Session (dieselben
// Ausnahmen wie im Authz-Guard server-action-authz.test.ts) — Datei oder
// `datei::Action`.
// =============================================================================

export const PUBLIC_ACTION_ENTRY_POINTS: Readonly<Record<string, string>> = {
  'app/gwg-onboarding/actions.ts':
    'Öffentlicher GwG-Onboarding-Flow: autorisiert über den Magic-Link-Token, es gibt keine Session.',
  'app/portal/(auth)/login/actions.ts':
    'Magic-Link-Login des Portals: etabliert erst die Identität, es gibt keine Session zu prüfen.',
  'app/staff/(auth)/login/actions.ts':
    'Passwort-, TOTP- und Hardware-Login: etabliert erst die Identität, es gibt keine Session zu prüfen.',
  'app/staff/(protected)/poa/sign-actions.ts::loadPoaForSigning':
    'Öffentlicher Vollmacht-Signaturflow: Lookup über den Hash des rawToken, rate-limitiert, ohne Session.',
  'app/staff/(protected)/poa/sign-actions.ts::requestSigningOtpAction':
    'Öffentlicher Vollmacht-Signaturflow: autorisiert über Besitz des rawToken, ohne Session.',
  'app/staff/(protected)/poa/sign-actions.ts::signPoaAction':
    'Öffentlicher Vollmacht-Signaturflow: autorisiert über rawToken und OTP, ohne Session.',
};

const EXCLUDED =
  'Ausgeschlossen aus K-02 (wird parallel umgebaut): Stand bei Einführung des Guards eingefroren, ' +
  'Re-Baseline nach der Integration.';
const PAYROLL =
  'Lohn-Familie: payrollAction kapselt Fehler-Mapping (ZodError → „Eingaben und Pflichtfelder ' +
  'prüfen.“, sonst Lohn-eigene Meldung) und Revalidate; die Services prüfen das Gate erneut ' +
  '(payrollGuard bzw. Capability-Session des Gastzugangs).';
const SUBSUMTION =
  'Subsumtion: eigene Guard-Familie (requireStaffSession + Ressourcen-Guards in _guards.ts mit ' +
  'Modulmeldung als ForbiddenError; Zugriff und Rechtestufe in EINER Transaktion).';
const OPEN =
  'Altbestand: staffActionGuard/portalActionGuard mit handgeschriebener Transaktion, try/catch ' +
  'und toActionError (Migration in K-02 offen).';

export const HANDWRITTEN_ACTION_BASELINE: Readonly<
  Record<string, { actions: number; reason: string }>
> = {
  'app/payroll/employee/actions.ts': { actions: 4, reason: PAYROLL },
  'app/portal/(protected)/appointments/actions.ts': { actions: 1, reason: OPEN },
  'app/portal/(protected)/bwa/plan/actions.ts': { actions: 2, reason: OPEN },
  'app/portal/(protected)/client-assistance/actions.ts': { actions: 3, reason: OPEN },
  'app/portal/(protected)/forms/[id]/actions.ts': { actions: 4, reason: OPEN },
  'app/portal/(protected)/inbox/actions.ts': { actions: 5, reason: OPEN },
  'app/portal/(protected)/payroll/actions.ts': { actions: 3, reason: PAYROLL },
  'app/portal/(protected)/profile-actions.ts': { actions: 1, reason: OPEN },
  'app/portal/(protected)/requests/[id]/actions.ts': { actions: 1, reason: OPEN },
  'app/portal/(protected)/stammdaten/actions.ts': { actions: 1, reason: OPEN },
  'app/portal/(protected)/stammdaten/tax-actions.ts': { actions: 1, reason: OPEN },
  'app/staff/(protected)/absences/actions.ts': { actions: 1, reason: OPEN },
  'app/staff/(protected)/admin/settings/branding-actions.ts': { actions: 4, reason: EXCLUDED },
  'app/staff/(protected)/admin/settings/infra-actions.ts': { actions: 3, reason: EXCLUDED },
  'app/staff/(protected)/admin/settings/integrations/signal-embedding-actions.ts': {
    actions: 3,
    reason: EXCLUDED,
  },
  'app/staff/(protected)/admin/settings/mail-actions.ts': { actions: 4, reason: EXCLUDED },
  'app/staff/(protected)/admin/settings/modules-actions.ts': { actions: 5, reason: EXCLUDED },
  'app/staff/(protected)/admin/settings/n8n-actions.ts': { actions: 16, reason: EXCLUDED },
  'app/staff/(protected)/client-assistance/actions.ts': { actions: 4, reason: OPEN },
  'app/staff/(protected)/clients/[id]/billing/actions.ts': { actions: 1, reason: OPEN },
  'app/staff/(protected)/clients/[id]/bwa/actions.ts': { actions: 3, reason: OPEN },
  'app/staff/(protected)/clients/[id]/bwa/plans/actions.ts': { actions: 1, reason: OPEN },
  'app/staff/(protected)/clients/[id]/contacts/actions.ts': { actions: 3, reason: OPEN },
  'app/staff/(protected)/clients/[id]/edit/actions.ts': { actions: 4, reason: OPEN },
  'app/staff/(protected)/clients/[id]/elster/actions.ts': { actions: 1, reason: OPEN },
  'app/staff/(protected)/clients/[id]/gwg/actions.ts': { actions: 3, reason: EXCLUDED },
  'app/staff/(protected)/clients/[id]/gwg/invite-actions.ts': { actions: 1, reason: EXCLUDED },
  'app/staff/(protected)/clients/[id]/handovers/actions.ts': { actions: 1, reason: OPEN },
  'app/staff/(protected)/clients/[id]/notices/actions.ts': { actions: 2, reason: OPEN },
  'app/staff/(protected)/clients/[id]/notices/filings/actions.ts': { actions: 1, reason: OPEN },
  'app/staff/(protected)/clients/[id]/privacy/actions.ts': { actions: 2, reason: OPEN },
  'app/staff/(protected)/clients/[id]/requests/actions.ts': { actions: 6, reason: OPEN },
  'app/staff/(protected)/clients/[id]/subsumtion/actions.ts': { actions: 14, reason: SUBSUMTION },
  'app/staff/(protected)/clients/[id]/subsumtion/norm-actions.ts': {
    actions: 10,
    reason: SUBSUMTION,
  },
  'app/staff/(protected)/clients/[id]/subsumtion/research-actions.ts': {
    actions: 10,
    reason: SUBSUMTION,
  },
  'app/staff/(protected)/clients/[id]/tax-schedule/actions.ts': { actions: 1, reason: OPEN },
  'app/staff/(protected)/clients/[id]/workflows/actions.ts': { actions: 1, reason: OPEN },
  'app/staff/(protected)/clients/new/actions.ts': { actions: 1, reason: OPEN },
  'app/staff/(protected)/clients/onboarding/[id]/actions.ts': { actions: 5, reason: OPEN },
  'app/staff/(protected)/clients/onboarding/new/actions.ts': { actions: 1, reason: OPEN },
  'app/staff/(protected)/dashboard/rss-feed-actions.ts': { actions: 1, reason: OPEN },
  'app/staff/(protected)/dashboard/tax-news-actions.ts': { actions: 1, reason: OPEN },
  'app/staff/(protected)/documents/actions.ts': { actions: 4, reason: EXCLUDED },
  'app/staff/(protected)/documents/folder-actions.ts': { actions: 6, reason: OPEN },
  'app/staff/(protected)/forms/actions.ts': { actions: 1, reason: OPEN },
  'app/staff/(protected)/inbox/actions.ts': { actions: 8, reason: OPEN },
  'app/staff/(protected)/invoices/actions.ts': { actions: 4, reason: OPEN },
  'app/staff/(protected)/knowledge/actions.ts': { actions: 4, reason: OPEN },
  'app/staff/(protected)/mailbox/actions.ts': { actions: 4, reason: OPEN },
  'app/staff/(protected)/mandate-expansion/actions.ts': { actions: 3, reason: OPEN },
  'app/staff/(protected)/payroll/actions.ts': { actions: 10, reason: PAYROLL },
  'app/staff/(protected)/phone-notes/actions.ts': { actions: 2, reason: OPEN },
  'app/staff/(protected)/poa/actions.ts': { actions: 3, reason: EXCLUDED },
  'app/staff/(protected)/requests/bulk-actions.ts': { actions: 1, reason: OPEN },
  'app/staff/(protected)/tax-deadlines/actions.ts': { actions: 1, reason: OPEN },
};
