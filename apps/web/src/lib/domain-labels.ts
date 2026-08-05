/**
 * Client- und serverseitig nutzbare Fachlabels.
 *
 * Abweichende Portal-/Export-Texte werden an der jeweiligen Stelle bewusst
 * per Spread überschrieben. Dadurch bleibt die Abweichung sichtbar, während
 * neue Enum-Werte nur an einer Stelle ergänzt werden müssen.
 */
export const DOCUMENT_CLASSIFICATION_LABELS: Readonly<Record<string, string>> = {
  GOBD_INVOICE: 'GoBD Rechnung',
  GOBD_CONTRACT: 'GoBD Vertrag',
  GOBD_TAX: 'GoBD Steuer',
  GWG_EVIDENCE: 'GwG-Nachweis',
  PERSONNEL: 'Personal',
  STAFF_PRIVATE: 'Intern',
  GENERAL: 'Allgemein',
};

export const NOTICE_KIND_LABELS: Readonly<Record<string, string>> = {
  USTA: 'USt-Voranmeldung',
  UST_JAHR: 'USt-Jahresbescheid',
  EST: 'Einkommensteuer',
  KST: 'Körperschaftsteuer',
  GEWST_MESSBESCHEID: 'GewSt-Messbescheid',
  GEWST: 'GewSt-Bescheid',
  LSTA: 'LSt-Anmeldung',
  FESTSTELLUNG: 'Feststellungsbescheid',
  ZERLEGUNG: 'Zerlegungsbescheid',
  SONSTIGE: 'Sonstige',
};

export const NOTICE_STATUS_LABELS: Readonly<Record<string, string>> = {
  NEU: 'Neu',
  GEPRUEFT: 'Geprüft',
  EINSPRUCH: 'Einspruch eingelegt',
  ABGEHOLFEN: 'Einspruch abgeholfen',
  TEILABHILFE: 'Teilweise abgeholfen',
  ZURUECKGEWIESEN: 'Einspruch zurückgewiesen',
  KLAGE: 'Klage beim Finanzgericht',
  RECHTSKRAEFTIG: 'Rechtskräftig',
};

export const NOTIFICATION_KIND_LABELS: Readonly<Record<string, string>> = {
  REQUEST_RESPONDED: 'Anforderung beantwortet',
  POA_SIGNED: 'Vollmacht unterschrieben',
  POA_EXPIRY_SOON: 'Vollmacht läuft bald aus',
  POA_EXPIRED: 'Vollmacht abgelaufen',
  GWG_EXPIRY_SOON: 'GwG läuft bald aus',
  GWG_ONBOARDING_SUBMITTED: 'GwG-Onboarding eingereicht',
  SYSTEM_MAIL_FAILED: 'Mailversand fehlgeschlagen',
  INVOICE_OVERDUE: 'Rechnung überfällig',
  PHONE_NOTE_FORWARDED: 'Telefonzettel weitergeleitet',
  RISK_MARKING_ASSIGNED: 'Begriff zur Recherche zugewiesen',
  VACATION_DECISION: 'Urlaubsentscheidung',
  VACATION_REQUESTED: 'Urlaubsantrag',
  ABSENCE_REPORTED: 'Abwesenheitsmeldung',
  CLIENT_MASTER_CHANGE_REQUEST: 'Mandanten-Stammdaten-Änderung',
  TAX_NEWS_NEW: 'Neue BMF/BFH-News',
  TAX_DEADLINE_REQUEST_PENDING: 'Auto-Anforderung angekündigt',
  SYSTEM_BACKUP_FAILED: 'Backup fehlgeschlagen',
  SYSTEM_AUDIT_BREAK: 'Audit-Chain-Bruch',
  SYSTEM_AUDIT_OK: 'Audit-Chain intakt',
};

export const INVOICE_STATUS_LABELS: Readonly<Record<string, string>> = {
  DRAFT: 'Entwurf',
  SENT: 'Versendet',
  PAID: 'Bezahlt',
  OVERDUE: 'Überfällig',
  CANCELLED: 'Storniert',
};

export const TAX_DEADLINE_STATUS_LABELS: Readonly<Record<string, string>> = {
  PLANNED: 'Geplant',
  REMINDED: 'Anforderung versendet',
  IN_PROGRESS: 'In Bearbeitung',
  SUBMITTED: 'Übermittelt',
  DONE: 'Erledigt',
  OVERDUE: 'Überfällig',
  SKIPPED: 'Übersprungen',
};

export const GWG_CHECK_STATUS_LABELS: Readonly<Record<string, string>> = {
  DRAFT: 'Entwurf',
  IN_REVIEW: 'In Prüfung',
  VERIFIED: 'Verifiziert',
  REJECTED: 'Abgelehnt',
  EXPIRED: 'Abgelaufen',
};

export const GWG_INVITE_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: 'Versendet',
  STARTED: 'In Bearbeitung',
  SUBMITTED: 'Übermittelt',
  EXPIRED: 'Abgelaufen',
  CANCELLED: 'Abgebrochen',
};

export const FORM_SUBMISSION_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: 'Ausstehend',
  DRAFT: 'Entwurf',
  SUBMITTED: 'Eingegangen',
  REVIEWED: 'Geprüft',
};

export type RiskHerkunft = 'WOERTLICH' | 'MUSTER' | 'TRIGGER' | 'EMBEDDING' | 'LLM' | 'BERATER';
export type RiskGovernanceTyp = 'FP' | 'FF' | 'IN';
export type RiskStufe = 'NIEDRIG' | 'MITTEL' | 'HOCH';
export type RiskWahrscheinlichkeit = 'SELTEN' | 'MOEGLICH' | 'WAHRSCHEINLICH' | 'HAEUFIG';
export type RiskStatus = 'OFFEN' | 'IN_PRUEFUNG' | 'KONTROLLIERT' | 'AKZEPTIERT';

export const RISK_HERKUNFT_LABELS: Readonly<Record<RiskHerkunft, string>> = {
  WOERTLICH: 'wörtlich',
  MUSTER: 'Muster',
  TRIGGER: 'Trigger',
  EMBEDDING: 'Heuristik',
  LLM: 'LLM',
  BERATER: 'Berater',
};

export const RISK_STATUS_LABELS: Readonly<Record<RiskStatus, string>> = {
  OFFEN: 'Offen',
  IN_PRUEFUNG: 'In Prüfung',
  KONTROLLIERT: 'Kontrolliert',
  AKZEPTIERT: 'Akzeptiert',
};

export const RISK_GOVERNANCE_LABELS: Readonly<Record<RiskGovernanceTyp, string>> = {
  FP: 'Festsetzung (FP)',
  FF: 'Feststellung (FF)',
  IN: 'Information (IN)',
};

export const RISK_STUFE_LABELS: Readonly<Record<RiskStufe, string>> = {
  NIEDRIG: 'Niedrig',
  MITTEL: 'Mittel',
  HOCH: 'Hoch',
};

export const RISK_WAHRSCHEINLICHKEIT_LABELS: Readonly<Record<RiskWahrscheinlichkeit, string>> = {
  SELTEN: 'Selten',
  MOEGLICH: 'Möglich',
  WAHRSCHEINLICH: 'Wahrscheinlich',
  HAEUFIG: 'Häufig',
};

export const RISK_ENGINE_STATUS_LABELS: Readonly<Record<string, string>> = {
  treffer: 'Treffer',
  luecke: 'Lücke',
  kandidat: 'Kandidat',
  unknown_risiko: 'Unknown-Risiko',
  berater: 'Berater-Definition',
};
