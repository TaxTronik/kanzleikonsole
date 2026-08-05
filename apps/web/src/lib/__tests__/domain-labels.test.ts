import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_CLASSIFICATION_LABELS,
  FORM_SUBMISSION_STATUS_LABELS,
  GWG_CHECK_STATUS_LABELS,
  GWG_INVITE_STATUS_LABELS,
  INVOICE_STATUS_LABELS,
  NOTICE_KIND_LABELS,
  NOTICE_STATUS_LABELS,
  RISK_ENGINE_STATUS_LABELS,
  RISK_GOVERNANCE_LABELS,
  RISK_HERKUNFT_LABELS,
  RISK_STATUS_LABELS,
  RISK_STUFE_LABELS,
  RISK_WAHRSCHEINLICHKEIT_LABELS,
  TAX_DEADLINE_STATUS_LABELS,
} from '../domain-labels';

describe('domain labels', () => {
  it('uses one canonical spelling for drift-prone labels', () => {
    expect(DOCUMENT_CLASSIFICATION_LABELS.GWG_EVIDENCE).toBe('GwG-Nachweis');
    expect(NOTICE_KIND_LABELS.GEWST_MESSBESCHEID).toBe('GewSt-Messbescheid');
    expect(NOTICE_STATUS_LABELS.ABGEHOLFEN).toBe('Einspruch abgeholfen');
    expect(NOTICE_STATUS_LABELS.KLAGE).toBe('Klage beim Finanzgericht');
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
});
