// =============================================================================
// Mandanten-Timeline-Aggregator
//
// Sammelt alle relevanten Ereignisse zu einem Mandanten aus mehreren Tabellen
// (Documents, Requests, Request-Responses, Phone-Notes, Invoices, GwG-Checks,
// Vollmachten) und mergt sie zu einem chronologischen Strom.
//
// Bewusst KEIN audit_log als Quelle: dort ist alles dabei (auch Reads), das
// würde die Timeline überfluten. Stattdessen direkt aus den fachlichen
// Tabellen — gibt nur "echte" Mandanten-Ereignisse, kein Rauschen.
// =============================================================================

import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';
import { fmtEUR } from '@/lib/fmt';

type TxClient = Prisma.TransactionClient;

export type TimelineEventKind =
  | 'document_uploaded'
  | 'request_opened'
  | 'request_closed'
  | 'request_response_staff'
  | 'request_response_client'
  | 'phone_note'
  | 'invoice_created'
  | 'invoice_sent'
  | 'invoice_paid'
  | 'gwg_created'
  | 'gwg_verified'
  | 'gwg_rejected'
  | 'poa_created'
  | 'poa_signed'
  | 'poa_revoked'
  | 'tax_notice_received'
  | 'tax_deadline_completed'
  | 'workflow_item_done';

export interface TimelineEvent {
  id: string;
  occurredAt: Date;
  kind: TimelineEventKind;
  title: string;
  detail?: string;
  href?: string;
}

export interface TimelineOptions {
  clientId: string;
  limit?: number;
  /** Nur Events vor diesem Datum einbeziehen (für Pagination) */
  before?: Date;
}

export async function buildClientTimeline(
  ctx: TenantContext,
  options: TimelineOptions,
): Promise<TimelineEvent[]> {
  const { clientId, limit = 100, before } = options;
  const beforeFilter = before ? { lt: before } : undefined;

  return withTenantContext(ctx, async (tx) => {
    const [docs, requests, responses, phoneNotes, invoices, gwgChecks, poas, taxNotices, taxDeadlines, workflowItems] =
      await Promise.all([
        tx.document.findMany({
          where: { clientId, ...(beforeFilter ? { createdAt: beforeFilter } : {}) },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: { id: true, title: true, classification: true, createdAt: true },
        }),
        tx.request.findMany({
          where: { clientId, ...(beforeFilter ? { createdAt: beforeFilter } : {}) },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: {
            id: true,
            title: true,
            status: true,
            priority: true,
            createdAt: true,
            closedAt: true,
          },
        }),
        loadResponses(tx, clientId, limit, beforeFilter),
        tx.phoneNote.findMany({
          where: { clientId, ...(beforeFilter ? { createdAt: beforeFilter } : {}) },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: {
            id: true,
            subject: true,
            callerName: true,
            createdAt: true,
          },
        }),
        tx.invoice.findMany({
          where: { clientId, ...(beforeFilter ? { createdAt: beforeFilter } : {}) },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: {
            id: true,
            number: true,
            subject: true,
            totalAmount: true,
            createdAt: true,
            sentAt: true,
            paidAt: true,
          },
        }),
        tx.gwgCheck.findMany({
          where: { clientId, ...(beforeFilter ? { createdAt: beforeFilter } : {}) },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: {
            id: true,
            status: true,
            riskLevel: true,
            createdAt: true,
            verifiedAt: true,
            rejectedReason: true,
          },
        }),
        tx.powerOfAttorney.findMany({
          where: { clientId, ...(beforeFilter ? { createdAt: beforeFilter } : {}) },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: {
            id: true,
            subject: true,
            signerName: true,
            createdAt: true,
            signedAt: true,
            revokedAt: true,
            revokedReason: true,
          },
        }),
        tx.taxNotice.findMany({
          where: { clientId, ...(beforeFilter ? { createdAt: beforeFilter } : {}) },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: {
            id: true,
            kind: true,
            period: true,
            createdAt: true,
            assessedAmount: true,
            expectedAmount: true,
          },
        }),
        tx.taxDeadline.findMany({
          where: {
            clientId,
            status: 'DONE',
            completedAt: { not: null, ...(beforeFilter ? beforeFilter : {}) },
          },
          orderBy: { completedAt: 'desc' },
          take: limit,
          select: {
            id: true,
            kind: true,
            period: true,
            completedAt: true,
          },
        }),
        tx.workflowItem.findMany({
          where: {
            instance: { clientId },
            doneAt: { not: null, ...(beforeFilter ? beforeFilter : {}) },
          },
          orderBy: { doneAt: 'desc' },
          take: limit,
          select: {
            id: true,
            title: true,
            doneAt: true,
            instance: { select: { id: true, name: true } },
          },
        }),
      ]);

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

    for (const res of responses) {
      events.push({
        id: `res:${res.id}`,
        occurredAt: res.createdAt,
        kind: res.authorType === 'CLIENT_CONTACT' ? 'request_response_client' : 'request_response_staff',
        title:
          res.authorType === 'CLIENT_CONTACT'
            ? `Mandant antwortete auf "${res.requestTitle}"`
            : `Mitarbeiter antwortete auf "${res.requestTitle}"`,
        detail: truncate(res.message, 120),
        href: `/staff/requests/${res.requestId}`,
      });
    }

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

    for (const inv of invoices) {
      const amt = formatEur(inv.totalAmount);
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

    for (const tn of taxNotices) {
      const expected = tn.expectedAmount ? formatEur(tn.expectedAmount) : null;
      const assessed = tn.assessedAmount ? formatEur(tn.assessedAmount) : null;
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

    events.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    return events.slice(0, limit);
  });
}

function noticeKindLabel(k: string): string {
  const m: Record<string, string> = {
    USTA: 'USt-VA', UST_JAHR: 'USt-Jahr', EST: 'ESt', KST: 'KSt',
    GEWST_MESSBESCHEID: 'GewSt-Mess', GEWST: 'GewSt', LSTA: 'LSt-Anmeldung',
    FESTSTELLUNG: 'Feststellung', ZERLEGUNG: 'Zerlegung', SONSTIGE: 'Sonstiger Bescheid',
  };
  return m[k] ?? k;
}

function scheduleKindLabel(k: string): string {
  const m: Record<string, string> = {
    USTA_MONATLICH: 'USt-VA monatlich', USTA_QUARTAL: 'USt-VA quartalsw.',
    USTA_JAEHRLICH: 'USt-Jahr', LSTA_MONATLICH: 'LSt monatlich',
    LSTA_QUARTAL: 'LSt quartalsw.', LSTA_JAEHRLICH: 'LSt-Jahr',
    EST_VZ: 'ESt-VZ', KST_VZ: 'KSt-VZ', GEWST_VZ: 'GewSt-VZ',
    EST_ERKLAERUNG: 'ESt-Erkl.', KST_ERKLAERUNG: 'KSt-Erkl.', GEWST_ERKLAERUNG: 'GewSt-Erkl.',
  };
  return m[k] ?? k;
}

async function loadResponses(
  tx: TxClient,
  clientId: string,
  limit: number,
  beforeFilter: { lt: Date } | undefined,
) {
  const rows = await tx.requestResponse.findMany({
    where: {
      request: { clientId },
      ...(beforeFilter ? { createdAt: beforeFilter } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      requestId: true,
      authorType: true,
      message: true,
      createdAt: true,
      request: { select: { title: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    requestId: r.requestId,
    authorType: r.authorType,
    message: r.message,
    createdAt: r.createdAt,
    requestTitle: r.request.title,
  }));
}

function classificationLabel(c: string): string {
  const m: Record<string, string> = {
    GOBD_INVOICE: 'GoBD Rechnung',
    GOBD_CONTRACT: 'GoBD Vertrag',
    GOBD_TAX: 'GoBD Steuer',
    GWG_EVIDENCE: 'GwG-Nachweis',
    PERSONNEL: 'Personal',
    STAFF_PRIVATE: 'Intern',
    GENERAL: 'Allgemein',
  };
  return m[c] ?? c;
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

function formatEur(d: { toString(): string }): string {
  const n = Number(d.toString());
  if (!Number.isFinite(n)) return '—';
  return fmtEUR(n);
}
