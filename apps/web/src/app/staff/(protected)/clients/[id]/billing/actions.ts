'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { berlinCalendarDate } from '@taxtronik/tax';
import { round2 } from '@/lib/fmt';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { createDraftInvoiceTx, dueDateError } from '@/server/invoicing/create-draft';
import { IN_APP_VAT_RATES } from '@/server/invoicing/vat';
import { readModules } from '@/server/settings/modules';
import { staffAction, ActionError } from '@/server/actions/staff-action';
import { buildTimeBillingPositions, validateTimeBillingTax } from '@/server/invoicing/time-billing';

// iter85 (GoB): kein number-Feld — automatische lückenlose Vergabe aus dem
// Nummernkreis (createDraftInvoiceTx, gemeinsam mit invoices/actions.ts).
const CreateSchema = z.object({
  clientId: z.string().uuid(),
  subject: z.string().min(1).max(500),
  issueDate: z.string().date(),
  dueDate: z.string().date(),
  vatRate: z.coerce
    .number()
    .refine((rate) => (IN_APP_VAT_RATES as readonly number[]).includes(rate), {
      message: 'Ungültiger USt-Satz (zulässig: 0 %, 7 %, 19 %).',
    })
    .default(19),
  vatExemptionReason: z.string().max(500).optional().or(z.literal('')),
  reverseCharge: z.boolean().optional().default(false),
  // Ein In-App-PDF ohne Generat/Dokument ist nicht versendbar. PDF-Belege
  // gehören ausschließlich in den EXTERNAL-Upload-Pfad.
  format: z.enum(['XRECHNUNG', 'ZUGFERD']).default('XRECHNUNG'),
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

export async function createInvoiceFromTimeEntriesAction(
  input: z.infer<typeof CreateSchema>,
): Promise<CreateResult> {
  // iter87: Stundenabrechnung legt Rechnungs-Entwürfe an → INVOICE_MANAGE.
  return staffAction({
    guard: {
      requirePermission: 'INVOICE_MANAGE',
      module: 'timeTracking',
      modeModule: 'invoices',
    },
    run: async ({ tenantId, staffId, ctx, session }) => {
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
      // INV-NUMBER-ALLOCATION-001: Fälligkeit nicht vor dem Rechnungsdatum schon vor
      // der Transaktion (der Anlageservice prüft sie erneut).
      const datesError = dueDateError(new Date(data.issueDate), new Date(data.dueDate));
      if (datesError) return { ok: false, error: datesError };
      const exemptionReason = data.vatExemptionReason || null;
      const taxError = validateTimeBillingTax({
        vatRate: data.vatRate,
        reverseCharge: data.reverseCharge,
        vatExemptionReason: exemptionReason,
      });
      if (taxError) return { ok: false, error: taxError };

      // Nummernkonflikt und GwG-Schranke bildet createDraftInvoiceTx ab.
      const invoiceId = await withTenantContext(ctx, async (tx) => {
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

        // Leistungszeitraum (§ 14 Abs. 4 Nr. 6 UStG, BT-73/BT-74) aus den
        // erfassten Zeiten ableiten. Ohne ihn defaultet der Generator BT-72
        // (Leistungsdatum) auf das Rechnungsdatum — bei Sammelabrechnung eines
        // früheren Zeitraums sachlich falsch. entries ist nach startedAt
        // aufsteigend sortiert und oben als non-empty geprüft; endedAt ist per
        // where-Filter garantiert non-null.
        const firstEntry = entries[0]!;
        // INV-TIME-ENTRY-CLAIM-001: @db.Date speichert Kalendertage. Die
        // UTC-Zeitpunkte zuerst auf den Berlin-Tag abbilden, auch nachts/DST.
        const servicePeriodStart = berlinCalendarDate(firstEntry.startedAt);
        const lastEntryEnd = entries.reduce(
          (max, e) => (e.endedAt! > max ? e.endedAt! : max),
          firstEntry.endedAt!,
        );
        const servicePeriodEnd = berlinCalendarDate(lastEntryEnd);

        // 2. Stundenwerte berechnen
        const entriesWithMinutes = entries.map((e) => {
          const end = e.endedAt!;
          const minutes = Math.max(0, Math.floor((end.getTime() - e.startedAt.getTime()) / 60_000));
          const hours = minutes / 60;
          // Stundensatz: pro-entry-Override > Default-Rate
          const rate = e.hourlyRate ? Number(e.hourlyRate.toString()) : data.hourlyRate;
          return { entry: e, minutes, hours, rate, net: round2(hours * rate) };
        });

        // 3. EN-16931-rechenfeste Positionen. Auch die Detailstrategie nutzt
        // Menge 1 und schreibt Dauer/Satz in den Text, weil Decimal(10,2) z. B.
        // 10 Minuten nicht als exakte Stundenmenge darstellen kann.
        const positions = buildTimeBillingPositions(
          entriesWithMinutes,
          data.strategy,
          data.subject,
          data.vatRate,
        );

        // 4. Entwurf über den gemeinsamen Anlageservice: alle Prüfungen
        // (u. a. § 13b UStG/BR-AE-01, Decimal-Grenzen) VOR der Nummernvergabe,
        // dann Nummer, Rechnung, atomarer Claim der Zeiteinträge und Audit in
        // derselben Tx (INV-TIME-ENTRY-CLAIM-001).
        const invoice = await createDraftInvoiceTx(
          tx,
          { tenantId, staffId },
          {
            clientId: data.clientId,
            subject: data.subject,
            issueDate: new Date(data.issueDate),
            dueDate: new Date(data.dueDate),
            servicePeriodStart,
            servicePeriodEnd,
            vatExemptionReason: exemptionReason,
            reverseCharge: data.reverseCharge,
            format: data.format,
            notes: data.notes || null,
          },
          positions,
          {
            kind: 'time_entries',
            entryIds: entries.map((entry) => entry.id),
            strategy: data.strategy,
          },
        );
        return invoice.id;
      });

      revalidatePath(`/staff/clients/${data.clientId}`);
      return { invoiceId };
    },
    revalidate: '/staff/invoices',
  });
}
