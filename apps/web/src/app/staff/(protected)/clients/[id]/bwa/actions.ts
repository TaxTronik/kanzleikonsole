'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { parseAddisonBwaCsv, parseAddisonBwaCompactCsv } from '@/server/bwa/addison-parser';
import { parseDatevBwaXlsx } from '@/server/bwa/datev-parser';

export interface ImportResult {
  ok: boolean;
  error?: string;
  imported?: number;
  skipped?: number;
  warnings?: string[];
}

const ImportSchema = z.object({
  clientId: z.string().uuid(),
  fileName: z.string().min(1).max(255),
  csv: z.string().min(1).max(2_000_000),
});

export async function importAddisonCsvAction(input: {
  clientId: string;
  fileName: string;
  csv: string;
}): Promise<ImportResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };

  const parsed = ImportSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { clientId, fileName, csv } = parsed.data;
  const { tenantId, staffId } = session.user;

  // Auto-Detect: Langform (a*.csv) beginnt mit `Nummer;…`; Kompaktform (s*.csv)
  // beginnt mit einer Mandantennummer + Titel-Zeile.
  const firstLine = csv.split(/\r?\n/, 1)[0] ?? '';
  const isCompact = !/^\s*Nummer;/.test(firstLine);
  const result = isCompact ? parseAddisonBwaCompactCsv(csv) : parseAddisonBwaCsv(csv);
  if (result.periods.length === 0) {
    return { ok: false, error: 'Keine BWA-Perioden im CSV erkannt.', warnings: result.warnings };
  }

  let imported = 0;
  let skipped = 0;

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // Sicherheits-Check: Mandant existiert in diesem Tenant
      const client = await tx.client.findUnique({ where: { id: clientId } });
      if (!client) throw new Error('Mandant nicht gefunden.');

      for (const period of result.periods) {
        // Existiert die Periode bereits? → Skip (idempotenter Re-Import nicht überschreibend)
        const existing = await tx.bwaPeriod.findFirst({
          where: { tenantId, clientId, periodKey: period.periodKey },
        });
        if (existing) {
          skipped++;
          continue;
        }
        const bp = await tx.bwaPeriod.create({
          data: {
            tenantId,
            clientId,
            periodType: period.type,
            periodKey: period.periodKey,
            fromDate: period.fromDate,
            toDate: period.toDate,
            source: 'ADDISON',
            sourceRef: fileName,
            importedById: staffId,
            positions: {
              create: period.positions.map((p) => ({
                number: p.number,
                label: p.label,
                amount: p.amount,
                sharePct: p.sharePct,
              })),
            },
          },
        });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'bwa.import',
          resourceType: 'bwa_period',
          resourceId: bp.id,
          after: {
            clientId,
            periodKey: period.periodKey,
            source: 'ADDISON',
            fileName,
            positionCount: period.positions.length,
          },
        });
        imported++;
      }
    },
  );

  revalidatePath(`/staff/clients/${clientId}/bwa`);
  return { ok: true, imported, skipped, warnings: result.warnings };
}

const DatevImportSchema = z.object({
  clientId: z.string().uuid(),
  fileName: z.string().min(1).max(255),
  // Base64-kodierter XLSX-Inhalt (binär muss durch das JSON-Server-Action-Bridge)
  xlsxBase64: z.string().min(1),
});

export async function importDatevXlsxAction(input: {
  clientId: string;
  fileName: string;
  xlsxBase64: string;
}): Promise<ImportResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };

  const parsed = DatevImportSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { clientId, fileName, xlsxBase64 } = parsed.data;
  const { tenantId, staffId } = session.user;

  let buffer: Buffer;
  try {
    buffer = Buffer.from(xlsxBase64, 'base64');
  } catch {
    return { ok: false, error: 'XLSX-Daten konnten nicht decodiert werden.' };
  }
  if (buffer.length === 0 || buffer.length > 20 * 1024 * 1024) {
    return { ok: false, error: 'Datei leer oder größer als 20 MB.' };
  }

  const result = await parseDatevBwaXlsx(buffer);
  if (result.periods.length === 0) {
    return { ok: false, error: 'Keine BWA-Perioden im XLSX erkannt.', warnings: result.warnings };
  }

  let imported = 0;
  let skipped = 0;

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const client = await tx.client.findUnique({ where: { id: clientId } });
      if (!client) throw new Error('Mandant nicht gefunden.');

      for (const period of result.periods) {
        const existing = await tx.bwaPeriod.findFirst({
          where: { tenantId, clientId, periodKey: period.periodKey },
        });
        if (existing) {
          skipped++;
          continue;
        }
        const bp = await tx.bwaPeriod.create({
          data: {
            tenantId,
            clientId,
            periodType: period.type,
            periodKey: period.periodKey,
            fromDate: period.fromDate,
            toDate: period.toDate,
            source: 'DATEV',
            sourceRef: fileName,
            importedById: staffId,
            positions: {
              create: period.positions.map((p) => ({
                number: p.number,
                label: p.label,
                amount: p.amount,
                sharePct: null,
              })),
            },
          },
        });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'bwa.import',
          resourceType: 'bwa_period',
          resourceId: bp.id,
          after: {
            clientId,
            periodKey: period.periodKey,
            source: 'DATEV',
            fileName,
            positionCount: period.positions.length,
          },
        });
        imported++;
      }
    },
  );

  revalidatePath(`/staff/clients/${clientId}/bwa`);
  return { ok: true, imported, skipped, warnings: result.warnings };
}

const DeleteSchema = z.object({
  periodId: z.string().uuid(),
  clientId: z.string().uuid(),
});

export async function deleteBwaPeriodAction(formData: FormData): Promise<void> {
  const session = await staffAuth();
  if (!session?.user) return;
  const parsed = DeleteSchema.safeParse({
    periodId: formData.get('periodId'),
    clientId: formData.get('clientId'),
  });
  if (!parsed.success) return;

  const { tenantId, staffId } = session.user;

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const before = await tx.bwaPeriod.findFirst({
        where: { id: parsed.data.periodId, clientId: parsed.data.clientId },
      });
      if (!before) return;
      await tx.bwaPeriod.delete({ where: { id: before.id } });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'bwa.delete',
        resourceType: 'bwa_period',
        resourceId: before.id,
        before: { periodKey: before.periodKey, source: before.source },
      });
    },
  );

  revalidatePath(`/staff/clients/${parsed.data.clientId}/bwa`);
}
