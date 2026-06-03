// =============================================================================
// ZUGFeRD-Archiv pro Rechnung (Option B: generate-on-issue + byte-stabile Ablage)
//
// Die ZUGFeRD-PDF (PDF/A-3 mit eingebettetem XRechnung-CII) ist CPU-intensiv und
// wurde bisher bei JEDEM Download neu erzeugt — zudem run-to-run nicht garantiert
// byte-identisch. Eine ausgestellte Rechnung ist aber immutabel. Wir erzeugen die
// PDF deshalb EINMAL (beim Ausstellen, sonst spätestens beim ersten Download) und
// legen sie revisionssicher (GOBD-Tier, Object-Lock COMPLIANCE) im Object-Store
// ab. Folge-Downloads streamen exakt dieselben Bytes — byte-stabile GoBD-Archiv-
// kopie, gespart wird die wiederholte CPU-Last.
//
// Verknüpfung über invoice.documentId (für IN-APP-Rechnungen sonst ungenutzt;
// EXTERNAL/PDF-Rechnungen tragen dort ihren Upload und werden hier ausgeschlossen).
// Die schwere Generierung läuft AUSSERHALB jeder DB-Tx (kein Tx hält die CPU-Last).
// =============================================================================

import type { TenantContext } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';
import { commitBytesWithTier } from '@taxtronik/storage';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { evidenceService } from '@/server/container';
import { generateXRechnungCii } from '@/server/invoicing/xrechnung';
import { generateZugferdPdf } from '@/server/invoicing/zugferd';
import { readSellerInfo } from '@/server/settings/tenant-settings';

export type ArchiveResult =
  | { ok: true; bucket: string; key: string; number: string }
  | { ok: false; code: 'not_found' | 'not_applicable' | 'seller_incomplete' | 'buyer_incomplete' };

/**
 * Liefert die gespeicherte ZUGFeRD-Archiv-PDF einer Rechnung (idempotent).
 * Existiert noch keine, wird sie einmal generiert + revisionssicher abgelegt +
 * an die Rechnung verknüpft. Validierungsfehler (Adresse unvollständig) kommen
 * als Code zurück — NICHT als Throw (die Aufrufer mappen sie selbst).
 */
export async function ensureZugferdArchive(ctx: TenantContext, invoiceId: string): Promise<ArchiveResult> {
  const actorId = ctx.actorId;
  if (!actorId) return { ok: false, code: 'not_found' };

  // 1. Rechnung (+ bestehendes Archiv) laden. Expliziter tenantId-Filter wie die
  //    Download-Routen (Defense in Depth gegen RLS-Drift bei Stammdaten-Belegen).
  const loaded = await withTenantContext(ctx, (tx) =>
    tx.invoice.findFirst({
      where: { id: invoiceId, tenantId: ctx.tenantId },
      include: {
        client: true,
        positions: { orderBy: { position: 'asc' } },
        document: { include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } } },
      },
    }),
  );
  if (!loaded) return { ok: false, code: 'not_found' };
  // EXTERNAL (PDF) hat kein ZUGFeRD-Generat — deren documentId ist der Upload.
  if (loaded.format === 'PDF') return { ok: false, code: 'not_applicable' };

  // Bereits archiviert? → exakt dieselben Bytes wiederverwenden.
  const existing = loaded.document?.versions[0];
  if (loaded.documentId && existing) {
    return { ok: true, bucket: existing.storageBucket, key: existing.storageKey, number: loaded.number };
  }

  // 2. Validierung (identisch zur bisherigen Download-Route).
  const seller = await readSellerInfo(ctx);
  if (!seller.name || !seller.street || !seller.city || !seller.postalCode) {
    return { ok: false, code: 'seller_incomplete' };
  }
  if (!loaded.client.street || !loaded.client.city || !loaded.client.postalCode) {
    return { ok: false, code: 'buyer_incomplete' };
  }

  // 3. Generieren (CPU — bewusst ausserhalb jeder DB-Tx).
  const xInput = {
    number: loaded.number,
    issueDate: loaded.issueDate,
    dueDate: loaded.dueDate,
    subject: loaded.subject,
    notes: loaded.notes,
    currency: 'EUR' as const,
    vatRate: Number(loaded.vatRate.toString()),
    netAmount: Number(loaded.netAmount.toString()),
    vatAmount: Number(loaded.vatAmount.toString()),
    totalAmount: Number(loaded.totalAmount.toString()),
    positions: loaded.positions.map((p) => ({
      position: p.position,
      description: p.description,
      quantity: Number(p.quantity.toString()),
      unit: p.unit,
      unitPrice: Number(p.unitPrice.toString()),
      netAmount: Number(p.netAmount.toString()),
    })),
  };
  const buyer = {
    name: loaded.client.name,
    street: loaded.client.street,
    postalCode: loaded.client.postalCode,
    city: loaded.client.city,
    countryIso: loaded.client.countryIso ?? 'DE',
    vatId: loaded.client.vatId,
    email: loaded.client.invoiceEmail,
  };
  const cii = generateXRechnungCii(xInput, seller, buyer);
  const pdfBytes = await generateZugferdPdf(xInput, seller, buyer, cii);

  // 4. Revisionssicher ablegen (GOBD-Tier, Object-Lock) — ebenfalls ausserhalb Tx.
  const stored = await commitBytesWithTier({ fileData: Buffer.from(pdfBytes), tier: 'GOBD', tenantId: ctx.tenantId });

  // 5. Document + Version anlegen + verknüpfen (Tx). Race-sicher: hat ein
  //    parallel laufender Aufruf inzwischen verknüpft, dessen Bytes nehmen.
  const result = await withTenantContext(ctx, async (tx) => {
    const fresh = await tx.invoice.findFirst({
      where: { id: invoiceId, tenantId: ctx.tenantId },
      include: { document: { include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } } } },
    });
    const freshVersion = fresh?.document?.versions[0];
    if (fresh?.documentId && freshVersion) {
      return { bucket: freshVersion.storageBucket, key: freshVersion.storageKey };
    }
    const doc = await tx.document.create({
      data: {
        tenantId: ctx.tenantId,
        clientId: loaded.clientId,
        title: `Rechnung ${loaded.number} (ZUGFeRD)`,
        classification: 'GOBD_INVOICE',
        mimeType: 'application/pdf',
      },
    });
    await tx.documentVersion.create({
      data: {
        documentId: doc.id,
        versionNo: 1,
        storageBucket: stored.targetBucket,
        storageKey: stored.targetKey,
        sha256: prismaBytes(stored.sha256),
        sizeBytes: stored.sizeBytes,
        immutable: stored.immutable,
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
        createdById: actorId,
      },
    });
    await tx.invoice.update({ where: { id: invoiceId }, data: { documentId: doc.id } });
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId,
      action: 'invoice.archive.zugferd',
      resourceType: 'invoice',
      resourceId: invoiceId,
      after: { documentId: doc.id, number: loaded.number, sizeBytes: Number(stored.sizeBytes) },
    });
    return { bucket: stored.targetBucket, key: stored.targetKey };
  });

  return { ok: true, bucket: result.bucket, key: result.key, number: loaded.number };
}
