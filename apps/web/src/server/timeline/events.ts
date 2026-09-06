import { fmtEUR } from '@/lib/fmt';
import { DOCUMENT_CLASSIFICATION_LABELS } from '@/lib/domain-labels';
import type { TimelineEvent } from './types';
import type { TimelineRecords } from './records';

export function projectTimelineEvents(
  records: TimelineRecords,
  clientId: string,
  titelSichtbar: (id: string) => boolean,
): TimelineEvent[] {
  return [
    ...docsEvents(records.docs),
    ...requestsEvents(records.requests),
    ...responsesEvents(records.responses),
    ...phoneNotesEvents(records.phoneNotes),
    ...invoicesEvents(records.invoices),
    ...gwgChecksEvents(records.gwgChecks, clientId),
    ...poasEvents(records.poas),
    ...taxNoticesEvents(records.taxNotices, clientId),
    ...taxDeadlinesEvents(records.taxDeadlines),
    ...workflowItemsEvents(records.workflowItems, clientId),
    ...riskAnalysesEvents(records.riskAnalyses, clientId, titelSichtbar),
  ];
}

function docsEvents(docs: TimelineRecords['docs']): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const d of docs) {
    events.push({
      id: `doc:${d.id}`,
      occurredAt: d.createdAt,
      kind: 'document_uploaded',
      title: `Dokument hochgeladen: ${d.title}`,
      detail: classificationLabel(d.classification),
      href: `/staff/documents/${d.id}`,
    });
  }
  return events;
}

function requestsEvents(requests: TimelineRecords['requests']): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const r of requests) {
    events.push({
      id: `req-open:${r.id}`,
      occurredAt: r.createdAt,
      kind: 'request_opened',
      title: `Anforderung gestellt: ${r.title}`,
      detail: `Priorität ${priorityLabel(r.priority)}`,
      href: `/staff/requests/${r.id}`,
    });
    if (r.closedAt) {
      events.push({
        id: `req-close:${r.id}`,
        occurredAt: r.closedAt,
        kind: 'request_closed',
        title: `Anforderung geschlossen: ${r.title}`,
        href: `/staff/requests/${r.id}`,
      });
    }
  }
  return events;
}

function responsesEvents(responses: TimelineRecords['responses']): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const res of responses) {
    events.push({
      id: `res:${res.id}`,
      occurredAt: res.createdAt,
      kind:
        res.authorType === 'CLIENT_CONTACT' ? 'request_response_client' : 'request_response_staff',
      title:
        res.authorType === 'CLIENT_CONTACT'
          ? `Mandant antwortete auf "${res.request.title}"`
          : `Mitarbeiter antwortete auf "${res.request.title}"`,
      detail: truncate(res.message, 120),
      href: `/staff/requests/${res.requestId}`,
    });
  }
  return events;
}

function phoneNotesEvents(phoneNotes: TimelineRecords['phoneNotes']): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const pn of phoneNotes) {
    events.push({
      id: `pn:${pn.id}`,
      occurredAt: pn.createdAt,
      kind: 'phone_note',
      title: `Telefonzettel: ${pn.subject}`,
      detail: `von ${pn.callerName}`,
      href: `/staff/phone-notes`,
    });
  }
  return events;
}

function invoicesEvents(invoices: TimelineRecords['invoices']): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const inv of invoices) {
    const amt = fmtEUR(inv.totalAmount);
    events.push({
      id: `inv-create:${inv.id}`,
      occurredAt: inv.createdAt,
      kind: 'invoice_created',
      title: `Rechnung ${inv.number} erstellt`,
      detail: `${inv.subject} — ${amt}`,
      href: `/staff/invoices/${inv.id}`,
    });
    if (inv.sentAt) {
      events.push({
        id: `inv-sent:${inv.id}`,
        occurredAt: inv.sentAt,
        kind: 'invoice_sent',
        title: `Rechnung ${inv.number} versendet`,
        detail: amt,
        href: `/staff/invoices/${inv.id}`,
      });
    }
    if (inv.paidAt) {
      events.push({
        id: `inv-paid:${inv.id}`,
        occurredAt: inv.paidAt,
        kind: 'invoice_paid',
        title: `Rechnung ${inv.number} bezahlt`,
        detail: amt,
        href: `/staff/invoices/${inv.id}`,
      });
    }
  }
  return events;
}

function gwgChecksEvents(
  gwgChecks: TimelineRecords['gwgChecks'],
  clientId: string,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const g of gwgChecks) {
    events.push({
      id: `gwg-create:${g.id}`,
      occurredAt: g.createdAt,
      kind: 'gwg_created',
      title: 'GwG-Prüfung angelegt',
      detail: g.riskLevel ? `Risiko ${g.riskLevel}` : undefined,
      href: `/staff/clients/${clientId}/gwg`,
    });
    if (g.verifiedAt) {
      events.push({
        id: `gwg-verify:${g.id}`,
        occurredAt: g.verifiedAt,
        kind: 'gwg_verified',
        title: 'GwG-Prüfung verifiziert',
        detail: g.riskLevel ? `Risiko ${g.riskLevel}` : undefined,
        href: `/staff/clients/${clientId}/gwg`,
      });
    }
    if (g.status === 'REJECTED' && g.rejectedReason) {
      events.push({
        id: `gwg-reject:${g.id}`,
        occurredAt: g.createdAt, // Status-Change-Datum nicht separat — best-effort
        kind: 'gwg_rejected',
        title: 'GwG-Prüfung abgelehnt',
        detail: g.rejectedReason,
        href: `/staff/clients/${clientId}/gwg`,
      });
    }
  }
  return events;
}

function poasEvents(poas: TimelineRecords['poas']): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const p of poas) {
    events.push({
      id: `poa-create:${p.id}`,
      occurredAt: p.createdAt,
      kind: 'poa_created',
      title: `Vollmacht angelegt: ${p.subject}`,
      detail: `Unterzeichner ${p.signerName}`,
      href: `/staff/poa/${p.id}`,
    });
    if (p.signedAt) {
      events.push({
        id: `poa-sign:${p.id}`,
        occurredAt: p.signedAt,
        kind: 'poa_signed',
        title: `Vollmacht signiert: ${p.subject}`,
        detail: `von ${p.signerName}`,
        href: `/staff/poa/${p.id}`,
      });
    }
    if (p.revokedAt) {
      events.push({
        id: `poa-revoke:${p.id}`,
        occurredAt: p.revokedAt,
        kind: 'poa_revoked',
        title: `Vollmacht widerrufen: ${p.subject}`,
        detail: p.revokedReason ?? undefined,
        href: `/staff/poa/${p.id}`,
      });
    }
  }
  return events;
}

function taxNoticesEvents(
  taxNotices: TimelineRecords['taxNotices'],
  clientId: string,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const tn of taxNotices) {
    const expected = tn.expectedAmount ? fmtEUR(tn.expectedAmount) : null;
    const assessed = tn.assessedAmount ? fmtEUR(tn.assessedAmount) : null;
    events.push({
      id: `tn:${tn.id}`,
      occurredAt: tn.createdAt,
      kind: 'tax_notice_received',
      title: `Bescheid erfasst: ${noticeKindLabel(tn.kind)} ${tn.period}`,
      detail:
        assessed && expected
          ? `Festgesetzt ${assessed}, erwartet ${expected}`
          : assessed
            ? `Festgesetzt ${assessed}`
            : undefined,
      href: `/staff/clients/${clientId}/notices`,
    });
  }
  return events;
}

function taxDeadlinesEvents(taxDeadlines: TimelineRecords['taxDeadlines']): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const td of taxDeadlines) {
    if (!td.completedAt) continue;
    events.push({
      id: `td:${td.id}`,
      occurredAt: td.completedAt,
      kind: 'tax_deadline_completed',
      title: `Steuertermin erledigt: ${scheduleKindLabel(td.kind)} ${td.period}`,
      href: `/staff/tax-deadlines`,
    });
  }
  return events;
}

function workflowItemsEvents(
  workflowItems: TimelineRecords['workflowItems'],
  clientId: string,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const wi of workflowItems) {
    if (!wi.doneAt) continue;
    events.push({
      id: `wi:${wi.id}`,
      occurredAt: wi.doneAt,
      kind: 'workflow_item_done',
      title: `Workflow-Schritt erledigt: ${wi.title}`,
      detail: wi.instance?.name ?? undefined,
      href: `/staff/clients/${clientId}/workflows`,
    });
  }
  return events;
}

function riskAnalysesEvents(
  riskAnalyses: TimelineRecords['riskAnalyses'],
  clientId: string,
  titelSichtbar: (id: string) => boolean,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const a of riskAnalyses) {
    events.push({
      id: `ra:${a.id}`,
      occurredAt: a.createdAt,
      kind: 'risk_analysis_created',
      title: titelSichtbar(a.id)
        ? `Subsumtion analysiert: ${a.title ?? 'Ohne Titel'}`
        : 'Subsumtion analysiert (vertraulich)',
      // Voller Evidenz-Hash (sha256 des Sachverhalts) — rekonstruierbar +
      // in der Hash-Chain (audit_log) verankert.
      detail: `${a._count.markings} Markierungen · Katalog ${a.katalogVersion} · Hash ${a.textHash}`,
      href: `/staff/clients/${clientId}/subsumtion/${a.id}`,
    });
    if (a.archivedAt) {
      events.push({
        id: `ra-arch:${a.id}`,
        occurredAt: a.archivedAt,
        kind: 'risk_analysis_archived',
        title: titelSichtbar(a.id)
          ? `Subsumtion revisionssicher archiviert: ${a.title ?? 'Ohne Titel'}`
          : 'Subsumtion revisionssicher archiviert (vertraulich)',
        detail: `GoBD-Snapshot (Object-Lock) · Hash ${a.textHash}`,
        href: `/staff/clients/${clientId}/subsumtion/${a.id}`,
      });
    }
  }
  return events;
}

function noticeKindLabel(k: string): string {
  const m: Record<string, string> = {
    USTA: 'USt-VA',
    UST_JAHR: 'USt-Jahr',
    EST: 'ESt',
    KST: 'KSt',
    GEWST_MESSBESCHEID: 'GewSt-Mess',
    GEWST: 'GewSt',
    LSTA: 'LSt-Anmeldung',
    FESTSTELLUNG: 'Feststellung',
    ZERLEGUNG: 'Zerlegung',
    SONSTIGE: 'Sonstiger Bescheid',
  };
  return m[k] ?? k;
}

function scheduleKindLabel(k: string): string {
  const m: Record<string, string> = {
    USTA_MONATLICH: 'USt-VA monatlich',
    USTA_QUARTAL: 'USt-VA quartalsw.',
    USTA_JAEHRLICH: 'USt-Jahr',
    LSTA_MONATLICH: 'LSt monatlich',
    LSTA_QUARTAL: 'LSt quartalsw.',
    LSTA_JAEHRLICH: 'LSt-Jahr',
    EST_VZ: 'ESt-VZ',
    KST_VZ: 'KSt-VZ',
    GEWST_VZ: 'GewSt-VZ',
    EST_ERKLAERUNG: 'ESt-Erkl.',
    KST_ERKLAERUNG: 'KSt-Erkl.',
    GEWST_ERKLAERUNG: 'GewSt-Erkl.',
  };
  return m[k] ?? k;
}

function classificationLabel(c: string): string {
  return DOCUMENT_CLASSIFICATION_LABELS[c] ?? c;
}

function priorityLabel(p: string): string {
  const m: Record<string, string> = {
    LOW: 'Niedrig',
    NORMAL: 'Normal',
    HIGH: 'Hoch',
    URGENT: 'Dringend',
  };
  return m[p] ?? p;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
