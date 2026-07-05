'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { fmtDateShort, round2 } from '@/lib/fmt';
import { toActionError, assertClientAccessTx } from '@/server/auth/rbac';
import { allocateInvoiceNumber } from '@/server/invoicing/number';
import { readModules } from '@/server/settings/modules';
import { staffActionGuard, ActionError } from '@/server/actions/staff-action';

// iter85 (GoB): kein number-Feld — automatische lückenlose Vergabe aus dem
// Nummernkreis (siehe invoices/actions.ts).
const CreateSchema = z.object({
  clientId: z.string().uuid(),
  subject: z.string().min(1).max(500),
  issueDate: z.string().date(),
  dueDate: z.string().date(),
  vatRate: z.coerce.number().min(0).max(99).default(19),
  format: z.enum(['PDF', 'XRECHNUNG', 'ZUGFERD']).default('XRECHNUNG'),
  hourlyRate: z.coerce.number().min(0).max(10000).default(120),
  // Welche Strategie:
  //   - 'one-line': eine Position „Beratungsstunden Q3 2025" mit Σ Minuten
  //   - 'per-entry': jeder Time-Entry wird zu einer Position
  strategy: z.enum(['one-line', 'per-entry']).default('one-line'),
  // ID-Filter: nur diese Time-Entries einschließen (sonst alle nicht-abgerechneten billable für diesen Mandanten)
  entryIds: z.array(z.string().uuid()).optional(),
  notes: z.string().max(5000).optional().or(z.literal('')),
});

export interface CreateResult {
  ok: boolean;
  error?: string;
  invoiceId?: string;
}

export async function createInvoiceFromTimeEntriesAction(input: z.infer<typeof CreateSchema>): Promise<CreateResult> {
  // iter87: Stundenabrechnung legt Rechnungs-Entwürfe an → INVOICE_MANAGE.
  const g = await staffActionGuard({ requirePermission: 'INVOICE_MANAGE' });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx, session } = g;

  // Defense in Depth (Befund 11): Stundenabrechnung erzeugt In-App-Rechnungen.
  const modules = await readModules(ctx);
  if (modules.invoiceMode !== 'IN_APP') {
    return { ok: false, error: 'Das Rechnungsmodul ist für diesen Vorgang nicht aktiviert.' };
  }

  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  const data = parsed.data;

  let invoiceId: string;
  try {
    invoiceId = await withTenantContext(ctx, async (tx) => {
      await assertClientAccessTx(tx, session, data.clientId);
      // 1. Sammle abrechenbare, nicht abgerechnete TimeEntries
      const where = {
        tenantId,
        clientId: data.clientId,
        billable: true,
        invoiceId: null,
        endedAt: { not: null }, // nur abgeschlossene Timer
        ...(data.entryIds ? { id: { in: data.entryIds } } : {}),
      };
      const entries = await tx.timeEntry.findMany({ where, orderBy: { startedAt: 'asc' } });
      if (entries.length === 0) {
        throw new ActionError('Keine abrechenbaren Stunden für diesen Mandanten.');
      }

      // 2. Stundenwerte berechnen
      const entriesWithMinutes = entries.map((e) => {
        const end = e.endedAt!;
        const minutes = Math.max(0, Math.floor((end.getTime() - e.startedAt.getTime()) / 60_000));
        const hours = minutes / 60;
        // Stundensatz: pro-entry-Override > Default-Rate
        const rate = e.hourlyRate ? Number(e.hourlyRate.toString()) : data.hourlyRate;
        return { entry: e, minutes, hours, rate, net: round2(hours * rate) };
      });

      const totalNet = round2(entriesWithMinutes.reduce((s, x) => s + x.net, 0));
      const vatAmount = round2((totalNet * data.vatRate) / 100);
      const totalGross = round2(totalNet + vatAmount);

      // 3. Positionen je nach Strategie
      // iter86: Stundenabrechnung ist einheitlich besteuert — der eine
      // Formular-Satz gilt für alle erzeugten Positionen.
      let positions: Array<{
        position: number;
        description: string;
        quantity: number;
        unit: string;
        unitPrice: number;
        netAmount: number;
        vatRate: number;
      }>;

      if (data.strategy === 'one-line') {
        const totalHours = round2(entriesWithMinutes.reduce((s, x) => s + x.hours, 0));
        const avgRate = totalHours > 0 ? round2(totalNet / totalHours) : data.hourlyRate;
        positions = [
          {
            position: 1,
            description: data.subject,
            quantity: totalHours,
            unit: 'Stunde',
            unitPrice: avgRate,
            netAmount: totalNet,
            vatRate: data.vatRate,
          },
        ];
      } else {
        positions = entriesWithMinutes.map((x, i) => ({
          position: i + 1,
          description: `${formatDateShort(x.entry.startedAt)} — ${x.entry.description}`,
          quantity: round2(x.hours),
          unit: 'Stunde',
          unitPrice: x.rate,
          netAmount: x.net,
          vatRate: data.vatRate,
        }));
      }

      // 4. Rechnung anlegen — Nummer lückenlos in derselben Tx vergeben
      const number = await allocateInvoiceNumber(tx, tenantId, new Date(data.issueDate));
      const inv = await tx.invoice.create({
        data: {
          tenantId,
          clientId: data.clientId,
          number,
          subject: data.subject,
          issueDate: new Date(data.issueDate),
          dueDate: new Date(data.dueDate),
          status: 'DRAFT',
          format: data.format,
          netAmount: totalNet,
          vatAmount,
          totalAmount: totalGross,
          vatRate: data.vatRate,
          notes: data.notes || null,
          createdByStaff: staffId,
          positions: { create: positions },
        },
      });

      // 5. TimeEntries verlinken
      await tx.timeEntry.updateMany({
        where: { id: { in: entries.map((e) => e.id) } },
        data: { invoiceId: inv.id },
      });

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'invoice.create.from_time',
        resourceType: 'invoice',
        resourceId: inv.id,
        after: {
          number,
          clientId: data.clientId,
          timeEntryCount: entries.length,
          totalAmount: totalGross,
          strategy: data.strategy,
        },
      });

      return inv.id;
    });
  } catch (e) {
    // Befund 8 (gleiche Bug-Klasse wie invoices/actions.ts): Prisma-Error-Code
    // statt fragiler Message-Substrings; GwG-Schranke über den stabilen
    // Trigger-Marker aus den Migrationen matchen.
    if ((e as { code?: string }).code === 'P2002') {
      return { ok: false, error: 'Rechnungsnummer existiert bereits.' };
    }
    if ((e as Error).message?.includes('GwG-Schranke')) {
      return { ok: false, error: 'Mandant ist nicht aktiv (GwG-Prüfung ausstehend).' };
    }
    return toActionError(e);
  }

  revalidatePath(`/staff/clients/${data.clientId}`);
  revalidatePath('/staff/invoices');
  return { ok: true, invoiceId };
}

/**
 * Variante als Form-Action (für direkten POST aus dem UI).
 * Nutzt 'one-line' und alle nicht-abgerechneten Stunden.
 */
export async function billAllPendingHoursAction(formData: FormData): Promise<void> {
  const g = await staffActionGuard({ requirePermission: 'INVOICE_MANAGE' });
  if (!g.ok) return; // void-Action: still abbrechen (die delegierte Action prüft erneut)

  const clientId = formData.get('clientId');
  const hourlyRate = Number(formData.get('hourlyRate') ?? 120);
  const subject = String(formData.get('subject') ?? 'Beratungsstunden');
  const issueDate = String(formData.get('issueDate') ?? '');
  const dueDate = String(formData.get('dueDate') ?? '');

  if (typeof clientId !== 'string' || !issueDate || !dueDate) {
    throw new Error('Pflichtfelder fehlen.');
  }

  const r = await createInvoiceFromTimeEntriesAction({
    clientId,
    subject,
    issueDate,
    dueDate,
    vatRate: Number(formData.get('vatRate') ?? 19),
    format: 'XRECHNUNG',
    hourlyRate,
    strategy: (formData.get('strategy') as 'one-line' | 'per-entry') ?? 'one-line',
    notes: String(formData.get('notes') ?? ''),
  });

  if (!r.ok || !r.invoiceId) throw new Error(r.error ?? 'Rechnungsanlage fehlgeschlagen.');
  redirect(`/staff/invoices/${r.invoiceId}`);
}

function formatDateShort(d: Date): string {
  return fmtDateShort(d);
}
