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
const SUBSUMTION =
  'Subsumtion: eigene Guard-Familie (requireStaffSession + Ressourcen-Guards in _guards.ts mit ' +
  'Modulmeldung als ForbiddenError; Zugriff und Rechtestufe in EINER Transaktion). Fehler ' +
  'laufen bereits vollständig über toActionError; kein staffActionGuard-Altbestand.';

export const HANDWRITTEN_ACTION_BASELINE: Readonly<
  Record<string, { actions: number; reason: string }>
> = {
  'app/payroll/employee/actions.ts': {
    actions: 4,
    reason:
      'Gastzugang des Arbeitnehmers: keine Staff-/Portal-Sitzung, autorisiert über die ' +
      'Capability-Session (guardPayrollEmployee*, withPayrollCapability); payrollAction nutzt ' +
      'dasselbe Lohn-Fehler-Mapping (payrollActionError) und Revalidate wie die Bausteine.',
  },
  'app/portal/(protected)/profile-actions.ts': {
    actions: 1,
    reason:
      'switchPortalProfileAction: Navigations-Action ohne Ergebnis-Kanal (form action) — jeder ' +
      'Ausgang ist eine Weiterleitung (Login, Dashboard, Rücksprung); der Wechsel schreibt das ' +
      'Session-Cookie. Kein ActionResult-Vertrag.',
  },
  'app/staff/(protected)/admin/settings/branding-actions.ts': { actions: 4, reason: EXCLUDED },
  'app/staff/(protected)/admin/settings/infra-actions.ts': { actions: 3, reason: EXCLUDED },
  'app/staff/(protected)/admin/settings/integrations/signal-embedding-actions.ts': {
    actions: 3,
    reason: EXCLUDED,
  },
  'app/staff/(protected)/admin/settings/mail-actions.ts': { actions: 4, reason: EXCLUDED },
  'app/staff/(protected)/admin/settings/modules-actions.ts': { actions: 5, reason: EXCLUDED },
  'app/staff/(protected)/admin/settings/n8n-actions.ts': { actions: 16, reason: EXCLUDED },
  'app/staff/(protected)/clients/[id]/gwg/actions.ts': { actions: 3, reason: EXCLUDED },
  'app/staff/(protected)/clients/[id]/gwg/invite-actions.ts': { actions: 1, reason: EXCLUDED },
  'app/staff/(protected)/clients/[id]/subsumtion/actions.ts': { actions: 14, reason: SUBSUMTION },
  'app/staff/(protected)/clients/[id]/subsumtion/norm-actions.ts': {
    actions: 10,
    reason: SUBSUMTION,
  },
  'app/staff/(protected)/clients/[id]/subsumtion/research-actions.ts': {
    actions: 10,
    reason: SUBSUMTION,
  },
  'app/staff/(protected)/documents/actions.ts': { actions: 4, reason: EXCLUDED },
  'app/staff/(protected)/documents/folder-actions.ts': {
    actions: 1,
    reason:
      'moveDocumentItemsAction: Bulk-Vertrag DocumentBulkResult — auch Ablehnung und ' +
      'Auswahlfehler kommen in Bulk-Form (bulkActionError: done/rejected), Gate und Fehler je ' +
      'Block über runDocumentBulk wie die Explorer-Bulk-Actions in documents/actions.ts.',
  },
  'app/staff/(protected)/knowledge/actions.ts': {
    actions: 1,
    reason:
      'searchArticles: Lese-Abfrage der Server-Komponente knowledge/page.tsx — liefert die ' +
      'Trefferliste (Ablehnung = leere Liste, technische Fehler erreichen die Fehlerseite), ' +
      'kein ActionResult-Vertrag.',
  },
  'app/staff/(protected)/poa/actions.ts': { actions: 3, reason: EXCLUDED },
};
