// Fachkatalog: TAX-NOTICE-APPEAL-001, TAX-NOTICE-DATARETRIEVAL-001, TAX-CONTROL-STATUS-001
// Review-Befund K-04: Die Bescheidzeile rendert Einspruchsfrist- und
// Status-/Klagefrist-Spalte unverändert. Die erwarteten Zellen stammen aus der
// Darstellung vor der Extraktion (notices.map-Callback in page.tsx).

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../status-select', () => ({
  NoticeStatusSelect: ({
    currentStatus,
    allowed,
  }: {
    currentStatus: string;
    allowed: string[];
  }) => <i data-select={`${currentStatus}>${allowed.join(',')}`} />,
}));

import { NoticeRow } from '../notice-row';
import { toNoticeRowVm, type NoticeRowInput } from '../notice-row-vm';

const TODAY = new Date('2026-10-06T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function inDays(days: number): Date {
  return new Date(TODAY.getTime() + days * DAY);
}

function notice(overrides: Partial<NoticeRowInput> = {}): NoticeRowInput {
  return {
    id: 'notice-1',
    kind: 'EST',
    period: '2025',
    fileNumber: null,
    noticeDate: new Date('2026-09-01T00:00:00.000Z'),
    deliveryMethod: 'POST',
    dateBasis: 'DISPATCH_DATE',
    legalRemedyInstructionStatus: 'WIRKSAM',
    retrievalIssuedAt: null,
    retrievalNotificationDate: null,
    retrievalNotificationLegacyFallback: false,
    retrievalNotificationDisputedOrLate: false,
    retrievedAt: null,
    retrievalConsentStatus: 'NOT_APPLICABLE',
    retrievalEligibility2027Status: 'NOT_APPLICABLE',
    retrievalPostalRequestStatus: 'NOT_APPLICABLE',
    retrievalPostalRequestReceivedAt: null,
    retrievalNotificationStatus: 'NOT_RECORDED',
    retrievalReinstatementReviewRequired: false,
    assessedAmount: null,
    expectedAmount: null,
    deadlineCalculationStatus: 'CALCULATED',
    appealDeadline: inDays(20),
    internalRiskDeadline: null,
    alternativeClaimedAccessDeadline: null,
    manualReviewRequired: false,
    manualReviewReason: null,
    status: 'NEU',
    appealFiledAt: null,
    appealFiledBy: null,
    appealResolvedAt: null,
    partialReliefReceivedAt: null,
    partialReliefReceivedBy: null,
    appealDecisionReceivedAt: null,
    appealDecisionLegalRemedyInstructionValid: null,
    klageDeadline: null,
    klageFiledAt: null,
    klageFiledBy: null,
    legalFinalAt: null,
    legalFinalBy: null,
    legalFinalReason: null,
    document: null,
    filing: null,
    ...overrides,
  };
}

/** Repräsentative Bescheide: alle Status, Fristzustände, manuelle Prüfung, Verspätung, Klage. */
const REPRESENTATIVE: Array<[string, Partial<NoticeRowInput>]> = [
  ['neu, Frist in 20 Tagen', {}],
  [
    'geprüft, Frist in 7 Tagen, Freigabe offen',
    {
      status: 'GEPRUEFT',
      appealDeadline: inDays(7),
      manualReviewRequired: true,
      manualReviewReason: 'RISK_DATE_ONLY, HOLIDAY_LOCALITY_UNKNOWN',
    },
  ],
  [
    'Einspruch, Frist seit 3 Tagen abgelaufen',
    {
      status: 'EINSPRUCH',
      appealDeadline: inDays(-3),
      appealFiledAt: inDays(-1),
      appealFiledBy: 'staff-1',
    },
  ],
  [
    'abgeholfen, manuelle Prüfung mit Szenarien und Wiedereinsetzung',
    {
      status: 'ABGEHOLFEN',
      deadlineCalculationStatus: 'MANUAL_REVIEW',
      appealDeadline: null,
      internalRiskDeadline: inDays(3),
      alternativeClaimedAccessDeadline: inDays(12),
      manualReviewRequired: true,
      manualReviewReason: 'LATER_ACCESS_REQUIRES_EVIDENCE_REVIEW,UNBEKANNT_X',
      retrievalReinstatementReviewRequired: true,
    },
  ],
  [
    'Teilabhilfe mit Nachweis, Risikotermin, Klagefrist ausgeblendet',
    {
      status: 'TEILABHILFE',
      deadlineCalculationStatus: 'RISK_ONLY',
      appealDeadline: null,
      internalRiskDeadline: inDays(2),
      partialReliefReceivedAt: inDays(-4),
      partialReliefReceivedBy: 'staff-2',
      appealDecisionReceivedAt: inDays(-3),
      appealDecisionLegalRemedyInstructionValid: false,
      klageDeadline: inDays(3),
    },
  ],
  [
    'Teil-Einspruchsentscheidung nach Teilabhilfe, Belehrungsmangel',
    {
      status: 'TEILEINSPRUCHSENTSCHEIDUNG',
      partialReliefReceivedAt: inDays(-30),
      partialReliefReceivedBy: 'staff-2',
      appealDecisionReceivedAt: inDays(-10),
      appealDecisionLegalRemedyInstructionValid: false,
      klageDeadline: inDays(20),
    },
  ],
  [
    'zurückgewiesen, Klagefrist in 7 Tagen',
    {
      status: 'ZURUECKGEWIESEN',
      appealDecisionReceivedAt: inDays(-20),
      appealDecisionLegalRemedyInstructionValid: true,
      klageDeadline: inDays(7),
    },
  ],
  [
    'zurückgewiesen, Klagefrist in 8 Tagen',
    { status: 'ZURUECKGEWIESEN', klageDeadline: inDays(8) },
  ],
  [
    'Klage fristgerecht erhoben',
    {
      status: 'KLAGE',
      klageDeadline: inDays(-10),
      klageFiledAt: inDays(-12),
      klageFiledBy: 'staff-3',
    },
  ],
  [
    'Klage verspätet erhoben',
    {
      status: 'KLAGE',
      klageDeadline: inDays(-10),
      klageFiledAt: inDays(-5),
      klageFiledBy: 'staff-3',
    },
  ],
  [
    'bestandskräftig mit Disposition',
    {
      status: 'BESTANDSKRAEFTIG',
      klageDeadline: inDays(-30),
      legalFinalAt: inDays(-1),
      legalFinalBy: 'staff-4',
      legalFinalReason: 'Klage nicht erhoben',
    },
  ],
  [
    'bestandskräftig ohne Abschlussnachweis, Altbestand mit Frist',
    {
      status: 'BESTANDSKRAEFTIG',
      deadlineCalculationStatus: 'LEGACY_UNVERIFIED',
      appealDeadline: inDays(4),
      klageDeadline: inDays(-30),
    },
  ],
  [
    'Altbestand fachlich nicht beurteilt',
    { deadlineCalculationStatus: 'LEGACY_UNVERIFIED', appealDeadline: null },
  ],
];

/** Erwartete Einspruchsfrist- und Statuszelle je Fall (Darstellung vor K-04). */
const EXPECTED: Record<string, { deadline: string; status: string }> = {
  'neu, Frist in 20 Tagen': {
    deadline:
      '<td class="px-4 py-3"><div class="flex flex-col gap-0.5"><span class="text-xs text-muted">Kontrollvorschlag</span><span class="text-secondary">26.10.2026</span><span class="text-xs text-muted">noch 20 Tage</span></div></td>',
    status:
      '<td class="px-4 py-3"><span class="badge-yellow">Neu</span><i data-select="NEU&gt;GEPRUEFT,EINSPRUCH"></i></td>',
  },
  'geprüft, Frist in 7 Tagen, Freigabe offen': {
    deadline:
      '<td class="px-4 py-3"><div class="flex flex-col gap-0.5"><span class="text-xs font-medium text-amber-700">Kontrollvorschlag – fachliche Freigabe offen</span><span class="text-red-700 font-medium">13.10.2026</span><span class="text-xs text-muted">noch 7 Tage</span><span class="text-xs text-amber-700">nur Bescheiddatum als interner Risikobezug vorhanden</span><span class="text-xs text-amber-700">konkreter Feiertagsort ist nicht dokumentiert</span></div></td>',
    status:
      '<td class="px-4 py-3"><span class="badge-green">Geprüft</span><i data-select="GEPRUEFT&gt;NEU,EINSPRUCH,BESTANDSKRAEFTIG"></i></td>',
  },
  'Einspruch, Frist seit 3 Tagen abgelaufen': {
    deadline:
      '<td class="px-4 py-3"><div class="flex flex-col gap-0.5"><span class="text-xs text-muted">Kontrollvorschlag</span><span class="text-red-700 font-medium">3.10.2026</span><span class="text-xs text-muted">3 Tage abgelaufen</span></div></td>',
    status:
      '<td class="px-4 py-3"><span class="badge-yellow">Einspruch eingelegt</span><i data-select="EINSPRUCH&gt;ABGEHOLFEN,TEILABHILFE,TEILEINSPRUCHSENTSCHEIDUNG,ZURUECKGEWIESEN"></i></td>',
  },
  'abgeholfen, manuelle Prüfung mit Szenarien und Wiedereinsetzung': {
    deadline:
      '<td class="px-4 py-3"><div class="flex flex-col gap-0.5"><span class="text-xs font-medium text-amber-700">Manuelle Fristprüfung erforderlich</span><span class="text-xs text-amber-700">Szenario gesetzliche Fiktion: 9.10.2026</span><span class="text-xs text-amber-700">Szenario behaupteter späterer Zugang: 18.10.2026</span><span class="text-xs text-amber-700">behaupteter späterer Zugang ist zu würdigen</span><span class="text-xs text-amber-700">UNBEKANNT_X</span><span class="text-xs font-medium text-red-700">Wiedereinsetzung nach § 110 AO gesondert prüfen</span></div></td>',
    status:
      '<td class="px-4 py-3"><span class="badge-green">Einspruch abgeholfen</span><i data-select="ABGEHOLFEN&gt;BESTANDSKRAEFTIG"></i></td>',
  },
  'Teilabhilfe mit Nachweis, Risikotermin, Klagefrist ausgeblendet': {
    deadline:
      '<td class="px-4 py-3"><div class="flex flex-col gap-0.5"><span class="text-xs font-medium text-amber-700">Interner Risikotermin – keine Rechtsfrist</span><span class="text-amber-800">8.10.2026</span></div></td>',
    status:
      '<td class="px-4 py-3"><span class="badge-yellow">Teilweise abgeholfen</span><div class="text-xs text-muted mt-1">Teilabhilfe bekannt am 2.10.2026</div><i data-select="TEILABHILFE&gt;ABGEHOLFEN,TEILEINSPRUCHSENTSCHEIDUNG,ZURUECKGEWIESEN"></i></td>',
  },
  'Teil-Einspruchsentscheidung nach Teilabhilfe, Belehrungsmangel': {
    deadline:
      '<td class="px-4 py-3"><div class="flex flex-col gap-0.5"><span class="text-xs text-muted">Kontrollvorschlag</span><span class="text-secondary">26.10.2026</span><span class="text-xs text-muted">noch 20 Tage</span></div></td>',
    status:
      '<td class="px-4 py-3"><div class="text-xs text-muted mt-1">Teilabhilfe bekannt am 6.9.2026</div><span class="badge-red">Teil-Einspruchsentscheidung</span><div class="text-xs text-muted mt-1">Einspruchsentscheidung bekannt am 26.9.2026</div><div class="text-xs text-amber-700">Jahresfrist wegen Belehrungsmangel (§ 55 Abs. 2 FGO)</div><div class="text-xs mt-1 text-muted">Klagefrist: 26.10.2026</div><i data-select="TEILEINSPRUCHSENTSCHEIDUNG&gt;ABGEHOLFEN,ZURUECKGEWIESEN,KLAGE"></i></td>',
  },
  'zurückgewiesen, Klagefrist in 7 Tagen': {
    deadline:
      '<td class="px-4 py-3"><div class="flex flex-col gap-0.5"><span class="text-xs text-muted">Kontrollvorschlag</span><span class="text-secondary">26.10.2026</span><span class="text-xs text-muted">noch 20 Tage</span></div></td>',
    status:
      '<td class="px-4 py-3"><span class="badge-red">Einspruch zurückgewiesen</span><div class="text-xs text-muted mt-1">Einspruchsentscheidung bekannt am 16.9.2026</div><div class="text-xs mt-1 text-red-700 font-medium">Klagefrist: 13.10.2026</div><i data-select="ZURUECKGEWIESEN&gt;KLAGE,BESTANDSKRAEFTIG"></i></td>',
  },
  'zurückgewiesen, Klagefrist in 8 Tagen': {
    deadline:
      '<td class="px-4 py-3"><div class="flex flex-col gap-0.5"><span class="text-xs text-muted">Kontrollvorschlag</span><span class="text-secondary">26.10.2026</span><span class="text-xs text-muted">noch 20 Tage</span></div></td>',
    status:
      '<td class="px-4 py-3"><span class="badge-red">Einspruch zurückgewiesen</span><div class="text-xs mt-1 text-muted">Klagefrist: 14.10.2026</div><i data-select="ZURUECKGEWIESEN&gt;KLAGE,BESTANDSKRAEFTIG"></i></td>',
  },
  'Klage fristgerecht erhoben': {
    deadline:
      '<td class="px-4 py-3"><div class="flex flex-col gap-0.5"><span class="text-xs text-muted">Kontrollvorschlag</span><span class="text-secondary">26.10.2026</span><span class="text-xs text-muted">noch 20 Tage</span></div></td>',
    status:
      '<td class="px-4 py-3"><span class="badge-red">Klage beim Finanzgericht</span><div class="text-xs mt-1 text-muted">Klagefrist: 26.9.2026 · erledigt</div><i data-select="KLAGE&gt;BESTANDSKRAEFTIG"></i></td>',
  },
  'Klage verspätet erhoben': {
    deadline:
      '<td class="px-4 py-3"><div class="flex flex-col gap-0.5"><span class="text-xs text-muted">Kontrollvorschlag</span><span class="text-secondary">26.10.2026</span><span class="text-xs text-muted">noch 20 Tage</span></div></td>',
    status:
      '<td class="px-4 py-3"><span class="badge-red">Klage beim Finanzgericht</span><div class="text-xs mt-1 text-muted">Klagefrist: 26.9.2026 · Einreichung dokumentiert, Fristkontrolle offen</div><i data-select="KLAGE&gt;BESTANDSKRAEFTIG"></i></td>',
  },
  'bestandskräftig mit Disposition': {
    deadline:
      '<td class="px-4 py-3"><div class="flex flex-col gap-0.5"><span class="text-xs text-muted">Kontrollvorschlag</span><span class="text-secondary">26.10.2026</span><span class="text-xs text-muted">noch 20 Tage</span></div></td>',
    status:
      '<td class="px-4 py-3"><span class="badge-gray">Bestandskräftig</span><div class="text-xs mt-1 text-muted">Klagefrist: 6.9.2026 · erledigt</div><i data-select="BESTANDSKRAEFTIG&gt;"></i></td>',
  },
  'bestandskräftig ohne Abschlussnachweis, Altbestand mit Frist': {
    deadline:
      '<td class="px-4 py-3"><div class="flex flex-col gap-0.5"><span class="text-xs font-medium text-amber-700">Altbestand – ungeprüfte Frist</span><span class="text-amber-800">10.10.2026</span></div></td>',
    status:
      '<td class="px-4 py-3"><span class="badge-gray">Bestandskräftig</span><div class="text-xs mt-1 text-muted">Klagefrist: 6.9.2026 · Abschlussnachweis unvollständig</div><i data-select="BESTANDSKRAEFTIG&gt;"></i></td>',
  },
  'Altbestand fachlich nicht beurteilt': {
    deadline:
      '<td class="px-4 py-3"><div class="flex flex-col gap-0.5"><span class="text-xs text-amber-700">Altbestand fachlich noch nicht beurteilt</span></div></td>',
    status:
      '<td class="px-4 py-3"><span class="badge-yellow">Neu</span><i data-select="NEU&gt;GEPRUEFT,EINSPRUCH"></i></td>',
  },
};

function cells(html: string): string[] {
  return html
    .split('<td')
    .slice(1)
    .map((cell) => `<td${cell.slice(0, cell.lastIndexOf('</td>'))}</td>`);
}

describe('Bescheidzeile', () => {
  it.each(REPRESENTATIVE)('%s', (name, overrides) => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <NoticeRow row={toNoticeRowVm(notice(overrides), TODAY)} />
        </tbody>
      </table>,
    );
    const [, , , , , deadline, status] = cells(html);
    expect({ deadline, status }).toEqual(EXPECTED[name]);
  });
});
