import { describe, expect, it } from 'vitest';
import { ClientKind, NotificationKind, RequestPriority, RequestStatus } from '@prisma/client';
import {
  CLIENT_KIND_LABELS,
  DOCUMENT_CLASSIFICATION_LABELS,
  DOCUMENT_SCOPE_LABELS,
  domainLabel,
  FORM_SUBMISSION_STATUS_LABELS,
  GWG_CHECK_STATUS_LABELS,
  GWG_INVITE_STATUS_LABELS,
  INVOICE_STATUS_LABELS,
  NOTICE_KIND_LABELS,
  NOTICE_STATUS_LABELS,
  NOTIFICATION_KIND_LABELS,
  PRIORITY_LABELS,
  REQUEST_STATUS_LABELS,
  RISK_ENGINE_STATUS_LABELS,
  RISK_GOVERNANCE_LABELS,
  RISK_HERKUNFT_LABELS,
  RISK_STATUS_LABELS,
  RISK_STUFE_LABELS,
  RISK_WAHRSCHEINLICHKEIT_LABELS,
  TAX_DEADLINE_STATUS_LABELS,
} from '../domain-labels';

describe('domain labels', () => {
  it('hat für JEDEN NotificationKind ein deutsches Label (kein Roh-Enum in der UI)', () => {
    // Die Benachrichtigungs-Seite und das Dashboard fallen sonst auf den
    // technischen Enum-Namen zurück (z. B. „CLIENT_REMINDER_MENTION").
    const missing = Object.values(NotificationKind).filter(
      (kind) => !NOTIFICATION_KIND_LABELS[kind],
    );
    expect(missing).toEqual([]);
  });

  it('uses one canonical spelling for drift-prone labels', () => {
    expect(DOCUMENT_CLASSIFICATION_LABELS.GWG_EVIDENCE).toBe('GwG-Nachweis');
    expect(NOTICE_KIND_LABELS.GEWST_MESSBESCHEID).toBe('GewSt-Messbescheid');
    expect(NOTICE_STATUS_LABELS.ABGEHOLFEN).toBe('Einspruch abgeholfen');
    expect(NOTICE_STATUS_LABELS.KLAGE).toBe('Klage beim Finanzgericht');
    expect(NOTICE_STATUS_LABELS.TEILEINSPRUCHSENTSCHEIDUNG).toBe('Teil-Einspruchsentscheidung');
    expect(NOTICE_STATUS_LABELS.BESTANDSKRAEFTIG).toBe('Bestandskräftig');
    expect(INVOICE_STATUS_LABELS.SENT).toBe('Versendet');
    expect(TAX_DEADLINE_STATUS_LABELS.REMINDED).toBe('Anforderung versendet');
    expect(GWG_CHECK_STATUS_LABELS.IN_REVIEW).toBe('In Prüfung');
    expect(GWG_INVITE_STATUS_LABELS.SUBMITTED).toBe('Übermittelt');
    expect(FORM_SUBMISSION_STATUS_LABELS.REVIEWED).toBe('Geprüft');
  });

  it('keeps UI and export labels for the risk domain aligned', () => {
    expect(RISK_HERKUNFT_LABELS.WOERTLICH).toBe('wörtlich');
    expect(RISK_STATUS_LABELS.IN_PRUEFUNG).toBe('In Prüfung');
    expect(RISK_GOVERNANCE_LABELS.FP).toBe('Festsetzung (FP)');
    expect(RISK_STUFE_LABELS.HOCH).toBe('Hoch');
    expect(RISK_WAHRSCHEINLICHKEIT_LABELS.MOEGLICH).toBe('Möglich');
    expect(RISK_ENGINE_STATUS_LABELS.luecke).toBe('Lücke');
  });

  it('makes intentional presentation overrides explicit', () => {
    const portalDocumentLabels = {
      ...DOCUMENT_CLASSIFICATION_LABELS,
      GOBD_INVOICE: 'Rechnung',
    };
    const portalInvoiceLabels = { ...INVOICE_STATUS_LABELS, SENT: 'Offen' };

    expect(portalDocumentLabels.GOBD_INVOICE).toBe('Rechnung');
    expect(portalInvoiceLabels.SENT).toBe('Offen');
    expect(INVOICE_STATUS_LABELS.SENT).toBe('Versendet');
  });

  // R-14: Anfragestatus, Priorität und Mandantentyp waren je Seite kopiert.
  it('führt Anfragestatus, Priorität und Mandantentyp vollständig an einer Stelle', () => {
    expect(Object.keys(REQUEST_STATUS_LABELS).sort()).toEqual(Object.values(RequestStatus).sort());
    expect(Object.keys(PRIORITY_LABELS).sort()).toEqual(Object.values(RequestPriority).sort());
    expect(Object.keys(CLIENT_KIND_LABELS).sort()).toEqual(Object.values(ClientKind).sort());
    expect(REQUEST_STATUS_LABELS).toEqual({
      OPEN: 'Offen',
      IN_PROGRESS: 'In Bearbeitung',
      RESPONDED: 'Beantwortet',
      CLOSED: 'Geschlossen',
      CANCELLED: 'Abgebrochen',
    });
    expect(PRIORITY_LABELS).toEqual({
      LOW: 'Niedrig',
      NORMAL: 'Normal',
      HIGH: 'Hoch',
      URGENT: 'Dringend',
    });
    expect(CLIENT_KIND_LABELS).toEqual({
      NATPERS: 'Natürliche Person',
      JURPERS: 'Juristische Person',
      PERSGES: 'Personengesellschaft',
    });
  });

  // R-14: Die Dokumentablage führte eine eigene Tabelle (KIND_LABEL).
  it('führt die Einstiegsebenen der Dokumentablage für jeden Mandantentyp', () => {
    expect(Object.keys(DOCUMENT_SCOPE_LABELS).sort()).toEqual(
      [...Object.values(ClientKind), 'INTERNAL'].sort(),
    );
    expect(DOCUMENT_SCOPE_LABELS).toEqual({
      NATPERS: 'Natürliche Personen',
      JURPERS: 'Juristische Personen',
      PERSGES: 'Personengesellschaften',
      INTERNAL: 'Kanzlei-intern',
    });
  });

  it('fällt für unbekannte Rohwerte auf den Wert zurück', () => {
    expect(domainLabel(CLIENT_KIND_LABELS, 'NATPERS')).toBe('Natürliche Person');
    expect(domainLabel(CLIENT_KIND_LABELS, 'UNBEKANNT')).toBe('UNBEKANNT');
  });
});
