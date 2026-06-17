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
import { commitBytesWithTier, type CommitDocumentResult } from '@taxtronik/storage';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { evidenceService } from '@/server/container';
import { generateXRechnungCii } from '@/server/invoicing/xrechnung';
import { generateZugferdPdf } from '@/server/invoicing/zugferd';
import { readSellerInfo } from '@/server/settings/tenant-settings';
import { readBranding } from '@/server/settings/branding';

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

  const shareable = loaded.status === 'SENT' || loaded.status === 'PAID' || loaded.status === 'OVERDUE';
  const xrechnungTitle = `Rechnung ${loaded.number} (XRechnung)`;

  // Bereits archiviert? → exakt dieselben Bytes wiederverwenden.
  const existing = loaded.document?.versions[0];
  if (loaded.documentId && existing) {
    // Selbstheilend: Wurde die Kopie als DRAFT erzeugt (sharedWithClientAt=null)
    // und die Rechnung ist inzwischen versendet, gibt sie dieser Aufruf jetzt
    // frei. Da der Helfer bei jedem ZUGFeRD-Download UND beim Versand läuft,
    // konvergiert die Portal-Freigabe so unabhängig vom Versand-Pfad — markSent
    // teilt zwar selbst, aber ein künftiger/abweichender Send-Pfad bleibt
    // dadurch abgedeckt. Idempotent über das sharedWithClientAt IS NULL.
    if (shareable && loaded.document && !loaded.document.sharedWithClientAt) {
      await withTenantContext(ctx, (tx) =>
        tx.document.updateMany({
          where: { id: loaded.documentId!, sharedWithClientAt: null },
          data: { sharedWithClientAt: new Date(), sharedByStaff: actorId },
        }),
      );
    }
    const existingXml = await withTenantContext(ctx, (tx) =>
      tx.document.findFirst({
        where: {
          tenantId: ctx.tenantId,
          clientId: loaded.clientId,
          title: xrechnungTitle,
          classification: 'GOBD_INVOICE',
          deletedAt: null,
        },
        include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } },
      }),
    );
    if (existingXml?.versions[0]) {
      if (shareable && !existingXml.sharedWithClientAt) {
        await withTenantContext(ctx, (tx) =>
          tx.document.updateMany({
            where: { id: existingXml.id, sharedWithClientAt: null },
            data: { sharedWithClientAt: new Date(), sharedByStaff: actorId },
          }),
        );
      }
    } else {
      const seller = await readSellerInfo(ctx);
      if (
        !seller.name || !seller.street || !seller.city || !seller.postalCode ||
        !seller.email || !seller.phone || (!seller.vatId && !seller.taxNumber)
      ) {
        return { ok: false, code: 'seller_incomplete' };
      }
      if (!loaded.client.street || !loaded.client.city || !loaded.client.postalCode) {
        return { ok: false, code: 'buyer_incomplete' };
      }
      const cii = generateXRechnungCii(
        {
          number: loaded.number,
          issueDate: loaded.issueDate,
          dueDate: loaded.dueDate,
          subject: loaded.subject,
          notes: loaded.notes,
          currency: 'EUR' as const,
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
            vatRate: Number(p.vatRate.toString()),
          })),
        },
        seller,
        {
          name: loaded.client.name,
          street: loaded.client.street,
          postalCode: loaded.client.postalCode,
          city: loaded.client.city,
          countryIso: loaded.client.countryIso ?? 'DE',
          vatId: loaded.client.vatId,
          email: loaded.client.invoiceEmail,
        },
      );
      const storedXml = await commitBytesWithTier({
        fileData: Buffer.from(cii, 'utf8'),
        tier: 'GOBD',
        tenantId: ctx.tenantId,
        skipScan: true,
      });
      await withTenantContext(ctx, async (tx) => {
        const xmlDoc = await tx.document.create({
          data: {
            tenantId: ctx.tenantId,
            clientId: loaded.clientId,
            title: xrechnungTitle,
            classification: 'GOBD_INVOICE',
            mimeType: 'application/xml',
            sharedWithClientAt: shareable ? new Date() : null,
            sharedByStaff: shareable ? actorId : null,
          },
        });
        await tx.documentVersion.create({
          data: {
            documentId: xmlDoc.id,
            versionNo: 1,
            storageBucket: storedXml.targetBucket,
            storageKey: storedXml.targetKey,
            sha256: prismaBytes(storedXml.sha256),
            sizeBytes: storedXml.sizeBytes,
            immutable: storedXml.immutable,
            scanStatus: 'CLEAN',
            scanCompletedAt: new Date(),
            createdById: actorId,
          },
        });
      });
    }
    return { ok: true, bucket: existing.storageBucket, key: existing.storageKey, number: loaded.number };
  }

  // 2. Validierung (identisch zur bisherigen Download-Route). E-Mail + Telefon
  // sind XRechnung-Pflicht (BG-6 Verkäufer-Kontakt, BR-DE-2/-6/-7); USt-ID ODER
  // Steuernummer ist bei Standardsatz Pflicht (EN-16931 BR-S-02/BR-CO-26) —
  // ohne sie würde nicht-konformes XML archiviert, daher fail-closed.
  const seller = await readSellerInfo(ctx);
  if (
    !seller.name || !seller.street || !seller.city || !seller.postalCode ||
    !seller.email || !seller.phone || (!seller.vatId && !seller.taxNumber)
  ) {
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
      vatRate: Number(p.vatRate.toString()),
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
  let pdfBytes: Uint8Array;
  let cii: string;
  try {
    const branding = await readBranding(ctx);
    cii = generateXRechnungCii(xInput, seller, buyer);
    pdfBytes = await generateZugferdPdf(xInput, seller, buyer, cii, branding.logoDataUrl);
  } catch (e) {
    // Schritt-Kontext im Fehlertext — sonst ist „ZUGFeRD geht nicht" nicht
    // von der PDF-Generierung vs. Ablage unterscheidbar.
    throw new Error(`ZUGFeRD-PDF-Generierung fehlgeschlagen: ${(e as Error).message}`, { cause: e });
  }

  // 4. Revisionssicher ablegen (GOBD-Tier, Object-Lock COMPLIANCE im GOBD-Bucket)
  //    — ebenfalls ausserhalb Tx. skipScan: App-eigene PDF (kein Nutzer-Upload),
  //    ClamAV ist hier sinnlos; die documentVersion wird mit scanStatus 'CLEAN' angelegt.
  let stored: CommitDocumentResult;
  try {
    stored = await commitBytesWithTier({ fileData: Buffer.from(pdfBytes), tier: 'GOBD', tenantId: ctx.tenantId, skipScan: true });
  } catch (e) {
    throw new Error(`ZUGFeRD-Ablage im GOBD-Object-Store fehlgeschlagen: ${(e as Error).message}`, { cause: e });
  }

  // XRechnung-XML parallel ablegen — erscheint als eigenständiges Dokument im
  // Mandantenordner (gleiche Generierung, nur XML statt PDF).
  let storedXml: CommitDocumentResult;
  try {
    storedXml = await commitBytesWithTier({ fileData: Buffer.from(cii, 'utf8'), tier: 'GOBD', tenantId: ctx.tenantId, skipScan: true });
  } catch (e) {
    throw new Error(`XRechnung-Ablage im GOBD-Object-Store fehlgeschlagen: ${(e as Error).message}`, { cause: e });
  }

  // 5. Document + Version anlegen + verknüpfen (Tx). Race-sicher: hat ein
  //    paralleler Erst-Download inzwischen verknüpft, nehmen wir dessen Bytes —
  //    es entsteht KEIN zweites Document. Die in S3 bereits abgelegten Bytes des
  //    Verlierers bleiben dann verwaist (selten: nur bei exakt gleichzeitigem
  //    Erst-Download eines nie archivierten Belegs; mit dem markSent-Hook quasi
  //    nie). Aufräumen ist NICHT möglich — GOBD-Tier liegt unter Object-Lock
  //    COMPLIANCE und ist bis Fristablauf unlöschbar. Bewusst akzeptiert.
  const result = await withTenantContext(ctx, async (tx) => {
    const fresh = await tx.invoice.findFirst({
      where: { id: invoiceId, tenantId: ctx.tenantId },
      include: { document: { include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } } } },
    });
    const freshVersion = fresh?.document?.versions[0];
    if (fresh?.documentId && freshVersion) {
      return { bucket: freshVersion.storageBucket, key: freshVersion.storageKey };
    }
    // Portal-Freigabe NUR für bereits versendete Rechnungen: Wird der ZUGFeRD-
    // Download für einen DRAFT geöffnet (Kontroll-Klick), entsteht zwar die
    // Archivkopie, sie darf aber nicht im Mandanten-Portal auftauchen. Beim
    // Versand selbst läuft dieser Helfer noch im Status DRAFT — markSentAction
    // gibt die Kopie nach dem Statuswechsel frei. Eine spätere Lazy-Erzeugung
    // bei schon versendeter Rechnung (z. B. Altbestand) wird hier direkt
    // freigegeben.
    const doc = await tx.document.create({
      data: {
        tenantId: ctx.tenantId,
        clientId: loaded.clientId,
        title: `Rechnung ${loaded.number} (ZUGFeRD)`,
        classification: 'GOBD_INVOICE',
        mimeType: 'application/pdf',
        sharedWithClientAt: shareable ? new Date() : null,
        sharedByStaff: shareable ? actorId : null,
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
    // XRechnung-XML als eigenständiges Dokument (selbe Freigabe-Logik wie das
    // ZUGFeRD-PDF), damit die XML separat im Mandantenordner auftaucht.
    // Idempotent: Wurde die XML vorher über den XRechnung-Button erzeugt, wird
    // sie nur noch freigegeben statt ein Duplikat anzulegen.
    const existingXmlDoc = await tx.document.findFirst({
      where: {
        tenantId: ctx.tenantId,
        clientId: loaded.clientId,
        title: xrechnungTitle,
        classification: 'GOBD_INVOICE',
        deletedAt: null,
      },
      include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } },
    });
    if (existingXmlDoc?.versions[0]) {
      if (shareable && !existingXmlDoc.sharedWithClientAt) {
        await tx.document.updateMany({
          where: { id: existingXmlDoc.id, sharedWithClientAt: null },
          data: { sharedWithClientAt: new Date(), sharedByStaff: actorId },
        });
      }
    } else {
      const xmlDoc = await tx.document.create({
        data: {
          tenantId: ctx.tenantId,
          clientId: loaded.clientId,
          title: xrechnungTitle,
          classification: 'GOBD_INVOICE',
          mimeType: 'application/xml',
          sharedWithClientAt: shareable ? new Date() : null,
          sharedByStaff: shareable ? actorId : null,
        },
      });
      await tx.documentVersion.create({
        data: {
          documentId: xmlDoc.id,
          versionNo: 1,
          storageBucket: storedXml.targetBucket,
          storageKey: storedXml.targetKey,
          sha256: prismaBytes(storedXml.sha256),
          sizeBytes: storedXml.sizeBytes,
          immutable: storedXml.immutable,
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
          createdById: actorId,
        },
      });
    }
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
