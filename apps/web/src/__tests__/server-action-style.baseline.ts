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

// R-12 (Audit-Akteur von Hand): evidenceService.record mit tenantId/actorType/
// actorId im Ereignis. Neue Audits: audit(tx, g, event). Ausnahmen haben keinen
// Gate-Kontext (öffentlicher Flow, Login) oder einen Helfer, der den Akteur als
// Parameter erhält.
export const HAND_FILLED_AUDIT_BASELINE: Readonly<
  Record<string, { calls: number; reason: string }>
> = {
  'app/gwg-onboarding/actions.ts': {
    calls: 3,
    reason:
      'Öffentlicher GwG-Onboarding-Flow ohne Sitzung: Akteur ist der Kontakt des Einladungs-Tokens (actorId null).',
  },
  'app/portal/(protected)/forms/[id]/actions.ts': {
    calls: 2,
    reason:
      'discardOpenFormUploadTx: Helfer erhält Mandant und Kontakt als Parameter (kein Gate-Kontext im Helfer).',
  },
  'app/portal/(protected)/profile-actions.ts': {
    calls: 1,
    reason:
      'switchPortalProfileAction: Akteur ist die Sitzung vor dem Profilwechsel (Navigations-Action ohne Gate-Kontext).',
  },
  'app/staff/(auth)/login/actions.ts': {
    calls: 1,
    reason: 'Login: die Identität entsteht erst (staffUser.id); es gibt keinen Gate-Kontext.',
  },
  'app/staff/(protected)/admin/settings/branding-actions.ts': { calls: 4, reason: EXCLUDED },
  'app/staff/(protected)/admin/settings/infra-actions.ts': { calls: 2, reason: EXCLUDED },
  'app/staff/(protected)/admin/settings/integrations/signal-embedding-actions.ts': {
    calls: 3,
    reason: EXCLUDED,
  },
  'app/staff/(protected)/admin/settings/mail-actions.ts': { calls: 3, reason: EXCLUDED },
  'app/staff/(protected)/admin/settings/modules-actions.ts': { calls: 5, reason: EXCLUDED },
  'app/staff/(protected)/admin/settings/n8n-actions.ts': { calls: 9, reason: EXCLUDED },
  'app/staff/(protected)/clients/[id]/gwg/actions.ts': { calls: 6, reason: EXCLUDED },
  'app/staff/(protected)/clients/[id]/gwg/id-document-actions.ts': { calls: 5, reason: EXCLUDED },
  'app/staff/(protected)/clients/[id]/gwg/invite-actions.ts': { calls: 2, reason: EXCLUDED },
  'app/staff/(protected)/clients/[id]/gwg/owner-actions.ts': { calls: 5, reason: EXCLUDED },
  'app/staff/(protected)/documents/actions.ts': { calls: 5, reason: EXCLUDED },
  'app/staff/(protected)/invoices/actions.ts': {
    calls: 2,
    reason:
      'finalizeInvoiceSendTx/cancelOriginalAfterDeliveredStornoTx: Helfer erhalten Mandant und Mitarbeiter als Parameter.',
  },
  'app/staff/(protected)/poa/actions.ts': { calls: 5, reason: EXCLUDED },
  'app/staff/(protected)/poa/sign-actions.ts': { calls: 1, reason: EXCLUDED },
  'server/actions/accessible-display.ts': {
    calls: 1,
    reason:
      'updateOptions: gemeinsamer Helfer beider Oberflächen; Akteur als Parameter, actorType aus der Oberfläche.',
  },
};

const FORM_DATA_OPEN =
  'R-12: FormData wird Feld für Feld gelesen; Umstellung auf parseFormData (Feldfehler) offen.';

// R-12 (FormData Feld für Feld): formData.get/getAll auf FormData-Parametern.
// Neue Form-Actions lesen über parseFormData(schema, formData).
export const FORM_DATA_READ_BASELINE: Readonly<Record<string, { reads: number; reason: string }>> =
  {
    'app/gwg-onboarding/actions.ts': { reads: 1, reason: FORM_DATA_OPEN },
    'app/payroll/employee/actions.ts': { reads: 6, reason: FORM_DATA_OPEN },
    'app/portal/(auth)/login/actions.ts': { reads: 3, reason: FORM_DATA_OPEN },
    'app/portal/(protected)/appointments/actions.ts': { reads: 5, reason: FORM_DATA_OPEN },
    'app/portal/(protected)/client-assistance/actions.ts': { reads: 11, reason: FORM_DATA_OPEN },
    'app/portal/(protected)/forms/[id]/actions.ts': { reads: 1, reason: FORM_DATA_OPEN },
    'app/portal/(protected)/payroll/actions.ts': { reads: 3, reason: FORM_DATA_OPEN },
    'app/portal/(protected)/profile-actions.ts': { reads: 2, reason: FORM_DATA_OPEN },
    'app/portal/(protected)/requests/[id]/actions.ts': { reads: 3, reason: FORM_DATA_OPEN },
    'app/portal/(protected)/settings/actions.ts': { reads: 1, reason: FORM_DATA_OPEN },
    'app/staff/(auth)/login/actions.ts': { reads: 3, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/absences/actions.ts': { reads: 3, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/admin/audit/actions.ts': { reads: 1, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/admin/dsgvo/actions.ts': { reads: 17, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/admin/privacy/actions.ts': { reads: 5, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/admin/settings/branding-actions.ts': { reads: 23, reason: EXCLUDED },
    'app/staff/(protected)/admin/settings/infra-actions.ts': { reads: 6, reason: EXCLUDED },
    'app/staff/(protected)/admin/settings/mail-actions.ts': { reads: 18, reason: EXCLUDED },
    'app/staff/(protected)/admin/settings/modules-actions.ts': { reads: 47, reason: EXCLUDED },
    'app/staff/(protected)/admin/settings/n8n-actions.ts': { reads: 23, reason: EXCLUDED },
    'app/staff/(protected)/admin/skills/actions.ts': { reads: 3, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/admin/users/actions.ts': { reads: 8, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/client-assistance/actions.ts': { reads: 19, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/clients/[id]/binders/actions.ts': { reads: 4, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/clients/[id]/bwa/actions.ts': { reads: 1, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/clients/[id]/edit/actions.ts': { reads: 20, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/clients/[id]/elster/actions.ts': { reads: 10, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/clients/[id]/gwg/actions.ts': { reads: 13, reason: EXCLUDED },
    'app/staff/(protected)/clients/[id]/gwg/id-document-actions.ts': {
      reads: 28,
      reason: EXCLUDED,
    },
    'app/staff/(protected)/clients/[id]/gwg/owner-actions.ts': { reads: 11, reason: EXCLUDED },
    'app/staff/(protected)/clients/[id]/handovers/actions.ts': { reads: 3, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/clients/[id]/notices/actions.ts': { reads: 44, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/clients/[id]/notices/filings/actions.ts': {
      reads: 1,
      reason: FORM_DATA_OPEN,
    },
    'app/staff/(protected)/clients/[id]/privacy/actions.ts': { reads: 8, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/clients/[id]/reminders/actions.ts': { reads: 7, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/clients/[id]/subsumtion/actions.ts': {
      reads: 1,
      reason: FORM_DATA_OPEN,
    },
    'app/staff/(protected)/clients/[id]/tax-schedule/actions.ts': {
      reads: 7,
      reason: FORM_DATA_OPEN,
    },
    'app/staff/(protected)/clients/new/actions.ts': { reads: 11, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/clients/onboarding/[id]/actions.ts': {
      reads: 13,
      reason: FORM_DATA_OPEN,
    },
    'app/staff/(protected)/clients/onboarding/new/actions.ts': {
      reads: 11,
      reason: FORM_DATA_OPEN,
    },
    'app/staff/(protected)/dashboard/rss-feed-actions.ts': { reads: 3, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/gwg/actions.ts': { reads: 4, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/interactions/actions.ts': { reads: 2, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/mailbox/actions.ts': { reads: 3, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/mandate-expansion/actions.ts': { reads: 30, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/mandate-expansion/structure/gwg-actions.ts': {
      reads: 6,
      reason: FORM_DATA_OPEN,
    },
    'app/staff/(protected)/payroll/actions.ts': { reads: 3, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/phone-notes/actions.ts': { reads: 6, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/poa/actions.ts': { reads: 12, reason: EXCLUDED },
    'app/staff/(protected)/profile/actions.ts': { reads: 3, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/service-providers/actions.ts': { reads: 7, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/tax-deadlines/actions.ts': { reads: 7, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/time/actions.ts': { reads: 3, reason: FORM_DATA_OPEN },
    'app/staff/(protected)/year-end/actions.ts': { reads: 2, reason: FORM_DATA_OPEN },
  };
