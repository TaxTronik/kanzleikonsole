// =============================================================================
// ZUGFeRD-Archiv pro Rechnung (Option B: generate-on-issue + byte-stabile Ablage)
//
// Die ZUGFeRD-PDF (Hybrid-PDF mit eingebettetem XRechnung-CII als Factur-X) ist CPU-intensiv und
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
//
// K-06 / DOC-UPLOAD-JOURNAL-001: PDF und XML werden vor dem Object-Write als
// Speicherabsichten journalisiert; die Verknüpfungstransaktion schließt genau
// die übernommenen Absichten atomar ab. Nicht übernommene (Race-Verlierer) und
// nach einem Abbruch offene Absichten löst der Cleanup-Worker nach dem
// Retention-Ende versionsgenau auf.
// =============================================================================

import type { TenantContext, TxClient } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';
import {
  fetchObjectBytes,
  prepareBytesCommitWithTier,
  type CommitDocumentResult,
} from '@taxtronik/storage';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { evidenceService } from '@/server/container';
import {
  generateXRechnungCii,
  toXRechnungInvoice,
  type StoredInvoiceForXRechnung,
  type XRechnungBuyer,
} from '@/server/invoicing/xrechnung';
import { extractFacturXXml, generateZugferdPdf } from '@/server/invoicing/zugferd';
import { UnsupportedPdfTextError } from '@/server/documents/pdf-fonts';
import { readSellerInfo, type SellerInfo } from '@/server/settings/tenant-settings';
import { readBranding } from '@/server/settings/branding';
import { readLetterhead } from '@/server/settings/letterhead';
import {
  journalStorageIntents,
  releaseStorageIntent,
  settleStorageIntentTx,
  storeStorageIntent,
  type StorageIntent,
} from '@/server/documents/storage-intent';
import { lockInvoiceArchiveTx } from '@/server/invoicing/archive-lock';
import { discardNeverSentDraftArchiveTx } from '@/server/invoicing/draft-archive';

/** Fehlende Pflichtangaben für die Erzeugung von XRechnung/ZUGFeRD. */
export type ArchiveInputFailure =
  | 'seller_incomplete'
  | 'reverse_charge_seller_no_vatid'
  | 'buyer_incomplete';

/** Alle fachlichen Ablehnungsgründe des Archivpfads (ohne technische Fehler). */
export type ArchiveFailureCode =
  | 'not_found'
  | 'not_applicable'
  | ArchiveInputFailure
  | 'status_conflict';

export type ArchiveResult =
  | { ok: true; bucket: string; key: string; storageVersionId?: string | null; number: string }
  | { ok: true; bytes: Buffer; number: string }
  | { ok: false; code: ArchiveFailureCode };

/** Gemeinsame Fail-closed-Prüfung vor jeder XRechnung-/ZUGFeRD-Erzeugung. */
function isSellerIncomplete(seller: SellerInfo): boolean {
  return (
    !seller.name ||
    !seller.street ||
    !seller.city ||
    !seller.postalCode ||
    !seller.email ||
    !seller.phone ||
    (!seller.vatId && !seller.taxNumber)
  );
}

/**
 * Freigabeprüfung (INV-PORTAL-SHARING-001): Archivfassungen werden dem
 * Mandanten erst nach der Ausstellung geteilt.
 */
export function isInvoiceShareable(invoice: { status: string; sentAt: Date | null }): boolean {
  // Ein nach Versand storniertes Original bleibt ein ausgestellter Beleg und
  // damit Teil der Mandantenakte. CANCELLED ohne sentAt ist dagegen nur ein
  // nie ausgestellter Entwurf und darf nicht freigegeben werden.
  return invoice.sentAt !== null || ['SENT', 'PAID', 'OVERDUE'].includes(invoice.status);
}

/**
 * Entwurfsprüfung: Ein stornierter, nie versendeter Entwurf ist kein Beleg.
 * Er darf weder freigegeben noch (nachträglich) archiviert werden.
 */
export function isCancelledDraft(invoice: { status: string; sentAt: Date | null }): boolean {
  return invoice.status === 'CANCELLED' && !invoice.sentAt;
}

/**
 * EXTERNAL-/PDF-Rechnungen haben kein Generat: Ihr Beleg ist der Upload, eine
 * XRechnung- oder ZUGFeRD-Fassung gibt es nicht (`not_applicable`).
 */
export function hasGeneratedEInvoice(invoice: { format: string }): boolean {
  return invoice.format !== 'PDF';
}

export interface ArchiveBuyerClient {
  name: string;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  countryIso: string | null;
  vatId: string | null;
  invoiceEmail: string | null;
}

export interface ArtifactInvoice extends StoredInvoiceForXRechnung {
  client: ArchiveBuyerClient;
}

/** Käufer-Mapping (BG-7) für XML-Vorschau, Archiv-XML und ZUGFeRD-PDF. */
export function xrechnungBuyer(client: ArchiveBuyerClient): XRechnungBuyer {
  return {
    name: client.name,
    street: client.street,
    postalCode: client.postalCode,
    city: client.city,
    countryIso: client.countryIso ?? 'DE',
    vatId: client.vatId,
    email: client.invoiceEmail,
  };
}

async function loadArchiveInvoice(ctx: TenantContext, invoiceId: string) {
  return withTenantContext(ctx, (tx) =>
    tx.invoice.findFirst({
      where: { id: invoiceId, tenantId: ctx.tenantId },
      include: {
        client: true,
        positions: { orderBy: { position: 'asc' } },
        document: { include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } } },
        xrechnungDocument: {
          include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } },
        },
        stornoOf: { select: { number: true } },
      },
    }),
  );
}

type LoadedArchiveInvoice = NonNullable<Awaited<ReturnType<typeof loadArchiveInvoice>>>;

async function generateInvoiceArtifacts(
  ctx: TenantContext,
  invoice: ArtifactInvoice,
  seller: SellerInfo,
): Promise<{ cii: string; pdfBytes: Uint8Array }> {
  const xInput = toXRechnungInvoice(invoice);
  const buyer = xrechnungBuyer(invoice.client);
  try {
    const [branding, letterhead] = await Promise.all([readBranding(ctx), readLetterhead(ctx)]);
    const cii = generateXRechnungCii(xInput, seller, buyer);
    const pdfBytes = await generateZugferdPdf(xInput, seller, buyer, cii, {
      logoDataUrl: branding.logoDataUrl,
      letterhead,
    });
    return { cii, pdfBytes };
  } catch (error) {
    // C5: Nicht darstellbare Zeichen sind eine fachliche Ablehnung mit UI-tauglicher
    // Meldung (Zeichen und Feld) und bleiben deshalb unverpackt.
    if (error instanceof UnsupportedPdfTextError) throw error;
    throw new Error(`ZUGFeRD-PDF-Generierung fehlgeschlagen: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

/**
 * Stammdatenprüfung vor jeder XRechnung-/ZUGFeRD-Erzeugung (Vorschau und
 * Archiv). E-Mail + Telefon sind XRechnung-Pflicht (BG-6 Verkäufer-Kontakt,
 * BR-DE-2/-6/-7); USt-ID ODER Steuernummer ist bei Standardsatz Pflicht
 * (EN-16931 BR-S-02/BR-CO-26); Reverse-Charge (Kategorie AE, BR-AE-01)
 * verlangt zwingend die USt-IdNr der Kanzlei.
 */
export function archiveInputFailure(
  invoice: {
    reverseCharge: boolean;
    client: { street: string | null; city: string | null; postalCode: string | null };
  },
  seller: SellerInfo,
): ArchiveInputFailure | null {
  if (isSellerIncomplete(seller)) return 'seller_incomplete';
  if (invoice.reverseCharge && !seller.vatId) return 'reverse_charge_seller_no_vatid';
  if (!invoice.client.street || !invoice.client.city || !invoice.client.postalCode) {
    return 'buyer_incomplete';
  }
  return null;
}

async function renderDraftPreview(
  ctx: TenantContext,
  invoice: ArtifactInvoice,
): Promise<ArchiveResult> {
  const seller = await readSellerInfo(ctx);
  const invalid = archiveInputFailure(invoice, seller);
  if (invalid) return { ok: false, code: invalid };
  const preview = await generateInvoiceArtifacts(ctx, invoice, seller);
  return { ok: true, bytes: Buffer.from(preview.pdfBytes), number: invoice.number };
}

/** Stand des Entwurfs, aus dem eine Kontrollvorschau gerendert wurde. */
export interface DraftPreviewSnapshot {
  updatedAt: Date;
  documentId: string | null;
  xrechnungDocumentId: string | null;
}

export type DraftPreviewRecheck =
  /** Unveränderter Entwurf: die frisch gerenderte Vorschau gilt. */
  | { state: 'preview' }
  | { state: 'not_found' | 'status_conflict' }
  /**
   * Ausstellung oder Archivverknüpfung hat das Rendern überholt: nie die
   * transiente Vorschau liefern, sondern die kanonische Archivfassung.
   * `pdf` ist die bereits verknüpfte ZUGFeRD-Version (falls vorhanden).
   */
  | {
      state: 'issued';
      pdf: { bucket: string; key: string; storageVersionId: string | null } | null;
    };

/**
 * Recheck einer DRAFT-Kontrollvorschau (XRechnung-XML und ZUGFeRD-PDF). Die
 * Generierung läuft absichtlich ohne lange DB-Transaktion; danach linearisiert
 * derselbe Archiv-Lock wie Versand/Storno den Snapshot. Normale
 * DRAFT-Änderungen führen fail-closed zu `status_conflict`.
 */
export async function recheckDraftPreview(
  ctx: TenantContext,
  invoiceId: string,
  snapshot: DraftPreviewSnapshot,
): Promise<DraftPreviewRecheck> {
  return withTenantContext(ctx, async (tx) => {
    await lockInvoiceArchiveTx(tx, invoiceId);
    const fresh = await tx.invoice.findFirst({
      where: { id: invoiceId, tenantId: ctx.tenantId },
      select: {
        status: true,
        sentAt: true,
        updatedAt: true,
        documentId: true,
        xrechnungDocumentId: true,
        document: {
          select: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } },
        },
      },
    });
    if (!fresh) return { state: 'not_found' };
    if (isCancelledDraft(fresh)) return { state: 'status_conflict' };

    const pointerChanged =
      fresh.documentId !== snapshot.documentId ||
      fresh.xrechnungDocumentId !== snapshot.xrechnungDocumentId;
    if (fresh.status === 'DRAFT' && !pointerChanged) {
      return fresh.updatedAt.getTime() === snapshot.updatedAt.getTime()
        ? { state: 'preview' }
        : { state: 'status_conflict' };
    }
    const archived = fresh.documentId ? fresh.document?.versions[0] : undefined;
    if (archived) {
      return {
        state: 'issued',
        pdf: {
          bucket: archived.storageBucket,
          key: archived.storageKey,
          storageVersionId: archived.storageVersionId,
        },
      };
    }
    // Ein Entwurf ohne verknüpfte Archivfassung ist (noch) nicht ausgestellt:
    // ein paralleler Versand läuft gerade. Kein Archiv aus dem GET erzeugen.
    if (fresh.status === 'DRAFT') return { state: 'status_conflict' };
    return { state: 'issued', pdf: null };
  });
}

async function renderConsistentDraftPreview(
  ctx: TenantContext,
  invoiceId: string,
  loaded: LoadedArchiveInvoice,
): Promise<ArchiveResult> {
  const preview = await renderDraftPreview(ctx, loaded);
  if (!preview.ok) return preview;

  // Gewinnt während des Renderns die Ausstellung, liefern wir niemals die
  // transienten Preview-Bytes, sondern exakt die inzwischen verknüpfte
  // Archivfassung.
  const rechecked = await recheckDraftPreview(ctx, invoiceId, loaded);
  if (rechecked.state === 'preview') return preview;
  if (rechecked.state === 'issued') {
    if (!rechecked.pdf) return ensureZugferdArchive(ctx, invoiceId, { purpose: 'ISSUE' });
    return { ok: true, ...rechecked.pdf, number: loaded.number };
  }
  return { ok: false, code: rechecked.state };
}

type DraftRefreshResult =
  | { state: 'not_found' }
  | { state: 'status_conflict' }
  | { state: 'changed' }
  | {
      state: 'ready';
      discarded: Awaited<ReturnType<typeof discardNeverSentDraftArchiveTx>>;
    };

async function refreshDraftArchive(
  ctx: TenantContext,
  invoiceId: string,
  actorId: string,
): Promise<DraftRefreshResult> {
  return withTenantContext(ctx, async (tx) => {
    await lockInvoiceArchiveTx(tx, invoiceId);
    const fresh = await tx.invoice.findFirst({
      where: { id: invoiceId, tenantId: ctx.tenantId },
      select: {
        id: true,
        tenantId: true,
        clientId: true,
        number: true,
        status: true,
        format: true,
        sentAt: true,
        documentId: true,
        xrechnungDocumentId: true,
      },
    });
    if (!fresh) return { state: 'not_found' };
    if (isCancelledDraft(fresh)) return { state: 'status_conflict' };
    if (fresh.status !== 'DRAFT') return { state: 'changed' };
    const discarded = await discardNeverSentDraftArchiveTx(
      tx,
      fresh,
      actorId,
      'Veraltetes Kontrollarchiv eines noch nicht versendeten Entwurfs wurde vor der Ausstellung ersetzt.',
    );
    if (discarded) {
      await evidenceService.record(tx, {
        tenantId: ctx.tenantId,
        actorType: 'STAFF',
        actorId,
        action: 'invoice.archive.draft.refresh',
        resourceType: 'invoice',
        resourceId: invoiceId,
        before: { documentIds: discarded.documentIds },
        after: { discardedAt: discarded.discardedAt },
      });
    }
    return { state: 'ready', discarded };
  });
}

/** Von der App selbst erzeugte GoBD-Rechnungsbytes (kein Nutzer-Upload, kein Scan). */
function prepareInvoiceArtifact(ctx: TenantContext, fileData: Buffer) {
  return prepareBytesCommitWithTier({
    fileData,
    tier: 'GOBD',
    tenantId: ctx.tenantId,
    skipScan: true,
    classification: 'GOBD_INVOICE',
  });
}

/** Lässt eine nicht übernommene Absicht für den Cleanup-Worker offen (Grund im Journal). */
async function releaseUnusedArtifact(
  intent: StorageIntent,
  stored: CommitDocumentResult,
  reason: string,
): Promise<void> {
  await releaseStorageIntent({ intent, commit: stored, cause: new Error(reason) });
}

async function commitLazyXrechnungDocument(input: {
  ctx: TenantContext;
  invoiceId: string;
  actorId: string;
  title: string;
  storedXml: CommitDocumentResult;
  xmlIntent: StorageIntent;
}): Promise<void> {
  let outcome: 'created' | 'existing' | 'not_found' | 'status_conflict';
  try {
    outcome = await withTenantContext(input.ctx, async (tx) => {
      await lockInvoiceArchiveTx(tx, input.invoiceId);
      const fresh = await tx.invoice.findFirst({
        where: { id: input.invoiceId, tenantId: input.ctx.tenantId },
        select: {
          clientId: true,
          status: true,
          sentAt: true,
          xrechnungDocumentId: true,
          xrechnungDocument: {
            select: {
              id: true,
              sharedWithClientAt: true,
              versions: { orderBy: { versionNo: 'desc' }, take: 1 },
            },
          },
        },
      });
      if (!fresh) return 'not_found';
      if (isCancelledDraft(fresh)) return 'status_conflict';

      const shareable = isInvoiceShareable(fresh);
      const existing = fresh.xrechnungDocument;
      if (fresh.xrechnungDocumentId && existing?.versions[0]) {
        if (shareable && !existing.sharedWithClientAt) {
          await tx.document.updateMany({
            where: { id: existing.id, sharedWithClientAt: null },
            data: { sharedWithClientAt: new Date(), sharedByStaff: input.actorId },
          });
        }
        return 'existing';
      }

      // Ein kanonischer Pointer ohne Version ist ein DB-Halbzustand. Nicht
      // titelbasiert auf irgendein anderes XML ausweichen, sondern den kaputten
      // Link nachvollziehbar lösen und die aus der Hybrid-PDF extrahierten
      // Bytes als neues kanonisches Dokument materialisieren.
      if (fresh.xrechnungDocumentId) {
        const detached = await tx.invoice.updateMany({
          where: { id: input.invoiceId, xrechnungDocumentId: fresh.xrechnungDocumentId },
          data: { xrechnungDocumentId: null },
        });
        if (detached.count !== 1) throw new Error('XRechnung-Link wurde parallel geändert.');
        await tx.document.updateMany({
          where: {
            id: fresh.xrechnungDocumentId,
            tenantId: input.ctx.tenantId,
            deletedAt: null,
          },
          data: {
            deletedAt: new Date(),
            deletedByStaff: input.actorId,
            deleteReason: 'Kanonischer XRechnung-Link ohne Dokumentversion wurde ersetzt.',
            sharedWithClientAt: null,
            sharedByStaff: null,
          },
        });
      }

      const xmlDoc = await tx.document.create({
        data: {
          tenantId: input.ctx.tenantId,
          clientId: fresh.clientId,
          title: input.title,
          classification: 'GOBD_INVOICE',
          mimeType: 'application/xml',
          retentionUntil: input.storedXml.retentionUntil,
          sharedWithClientAt: shareable ? new Date() : null,
          sharedByStaff: shareable ? input.actorId : null,
        },
      });
      await tx.documentVersion.create({
        data: {
          documentId: xmlDoc.id,
          versionNo: 1,
          storageBucket: input.storedXml.targetBucket,
          storageKey: input.storedXml.targetKey,
          storageVersionId: input.storedXml.storageVersionId,
          sha256: prismaBytes(input.storedXml.sha256),
          sizeBytes: input.storedXml.sizeBytes,
          immutable: input.storedXml.immutable,
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
          createdById: input.actorId,
        },
      });
      await tx.invoice.update({
        where: { id: input.invoiceId },
        data: { xrechnungDocumentId: xmlDoc.id },
      });
      await evidenceService.record(tx, {
        tenantId: input.ctx.tenantId,
        actorType: 'STAFF',
        actorId: input.actorId,
        action: 'invoice.archive.xrechnung',
        resourceType: 'invoice',
        resourceId: input.invoiceId,
        after: { documentId: xmlDoc.id, source: 'EMBEDDED_FACTUR_X' },
      });
      await settleStorageIntentTx(tx, input.xmlIntent, input.storedXml);
      return 'created';
    });
  } catch (error) {
    await releaseStorageIntent({ intent: input.xmlIntent, commit: input.storedXml, cause: error });
    throw error;
  }

  if (outcome !== 'created') {
    await releaseUnusedArtifact(
      input.xmlIntent,
      input.storedXml,
      `invoice.archive.lazy_xrechnung_${outcome}: Stored lazy XRechnung was not linked.`,
    );
  }
}

type ArchiveOptions = { purpose?: 'ISSUE' | 'PREVIEW' };

async function prepareDraftArchiveForIssue(
  ctx: TenantContext,
  invoiceId: string,
  actorId: string,
  loaded: LoadedArchiveInvoice,
  options: ArchiveOptions,
): Promise<ArchiveResult | null> {
  const refresh = await refreshDraftArchive(ctx, invoiceId, actorId);
  if (refresh.state === 'not_found' || refresh.state === 'status_conflict') {
    return { ok: false, code: refresh.state };
  }
  if (refresh.state === 'changed') {
    // Ein paralleler Versand hat den Status bereits festgeschrieben. Mit
    // einem frischen Read in den normalen Archiv-Lookup wechseln.
    return ensureZugferdArchive(ctx, invoiceId, options);
  }

  // `loaded` stammt von VOR dem Lock. Ein paralleler ISSUE-Aufruf kann das
  // alte DRAFT-Archiv bereits geloest haben; dann sieht dieser Refresh
  // korrekt keinen eigenen `discarded`-Treffer mehr. Der vorab geladene
  // Pointer ist trotzdem stale und darf keinesfalls wiederverwendet werden.
  // Nach `ready` ist der Zustand unter dem Lock immer "kein Draft-Archiv".
  loaded.documentId = null;
  loaded.document = null;
  loaded.xrechnungDocumentId = null;
  loaded.xrechnungDocument = null;
  return null;
}

async function reuseExistingArchive(
  ctx: TenantContext,
  invoiceId: string,
  actorId: string,
  loaded: LoadedArchiveInvoice,
): Promise<ArchiveResult | null> {
  const existing = loaded.document?.versions[0];
  if (!loaded.documentId || !existing) return null;

  const shareable = isInvoiceShareable(loaded);
  // Selbstheilend: Wurde die Kopie als DRAFT erzeugt (sharedWithClientAt=null)
  // und die Rechnung ist inzwischen versendet, gibt sie dieser Aufruf jetzt
  // frei. Idempotent über das sharedWithClientAt IS NULL.
  if (shareable && loaded.document && !loaded.document.sharedWithClientAt) {
    await withTenantContext(ctx, (tx) =>
      tx.document.updateMany({
        where: { id: loaded.documentId!, sharedWithClientAt: null },
        data: { sharedWithClientAt: new Date(), sharedByStaff: actorId },
      }),
    );
  }

  const existingXml = loaded.xrechnungDocument;
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
    // Legacy-Reparatur: Fehlt zur vorhandenen Hybrid-PDF die separate XML,
    // wird exakt deren eingebettete factur-x.xml extrahiert. Eine heutige
    // Neugenerierung aus inzwischen geänderten Stammdaten könnte sonst von
    // der bereits ausgestellten PDF abweichen.
    const archivedPdf = await fetchObjectBytes(
      existing.storageBucket,
      existing.storageKey,
      existing.storageVersionId,
    );
    const cii = await extractFacturXXml(archivedPdf);
    const [xmlIntent] = await journalStorageIntents({
      tenantId: ctx.tenantId,
      intents: [
        {
          source: 'invoice.archive.lazy_xrechnung',
          prepared: await prepareInvoiceArtifact(ctx, cii),
        },
      ],
    });
    const storedXml = await storeStorageIntent(xmlIntent!, cii);
    await commitLazyXrechnungDocument({
      ctx,
      invoiceId,
      actorId,
      title: `Rechnung ${loaded.number} (XRechnung)`,
      storedXml,
      xmlIntent: xmlIntent!,
    });
  }

  return {
    ok: true,
    bucket: existing.storageBucket,
    key: existing.storageKey,
    storageVersionId: existing.storageVersionId,
    number: loaded.number,
  };
}

interface StoredInvoiceArtifacts {
  stored: CommitDocumentResult;
  storedXml: CommitDocumentResult;
  pdfIntent: StorageIntent;
  xmlIntent: StorageIntent;
}

async function storeInvoiceArtifacts(
  ctx: TenantContext,
  pdfBytes: Uint8Array,
  cii: string,
): Promise<StoredInvoiceArtifacts> {
  const pdfData = Buffer.from(pdfBytes);
  const xmlData = Buffer.from(cii, 'utf8');
  // Beide Absichten werden gemeinsam vor dem ersten PUT journalisiert.
  let pdfIntent: StorageIntent;
  let xmlIntent: StorageIntent;
  let stored: CommitDocumentResult;
  try {
    [pdfIntent, xmlIntent] = (await journalStorageIntents({
      tenantId: ctx.tenantId,
      intents: [
        {
          source: 'invoice.archive.zugferd_pdf',
          prepared: await prepareInvoiceArtifact(ctx, pdfData),
        },
        {
          source: 'invoice.archive.xrechnung_xml',
          prepared: await prepareInvoiceArtifact(ctx, xmlData),
        },
      ],
    })) as [StorageIntent, StorageIntent];
    stored = await storeStorageIntent(pdfIntent, pdfData);
  } catch (error) {
    throw new Error(
      `ZUGFeRD-Ablage im GOBD-Object-Store fehlgeschlagen: ${(error as Error).message}`,
      { cause: error },
    );
  }

  try {
    const storedXml = await storeStorageIntent(xmlIntent, xmlData);
    return { stored, storedXml, pdfIntent, xmlIntent };
  } catch (error) {
    // Die PDF-Absicht bleibt mit gebundener Version offen; die XML-Absicht hat
    // ihren Fehler vermerkt. Der Worker löst beide nach dem Retention-Ende auf.
    await releaseStorageIntent({ intent: pdfIntent, commit: stored, cause: error });
    throw new Error(
      `XRechnung-Ablage im GOBD-Object-Store fehlgeschlagen: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

type ArchiveLinkResult =
  | {
      outcome: 'ready';
      bucket: string;
      key: string;
      storageVersionId: string | null;
      usedStoredPdf: boolean;
      usedStoredXml: boolean;
      needsCanonicalXml: boolean;
    }
  | { outcome: 'not_found' | 'status_conflict' };

interface GeneratedArchiveLinkInput extends StoredInvoiceArtifacts {
  ctx: TenantContext;
  invoiceId: string;
  actorId: string;
  number: string;
}

interface CanonicalXmlInvoice {
  clientId: string;
  xrechnungDocumentId: string | null;
  xrechnungDocument: {
    id: string;
    sharedWithClientAt: Date | null;
    versions: unknown[];
  } | null;
}

async function ensureCanonicalXmlDocumentTx(
  tx: TxClient,
  input: GeneratedArchiveLinkInput,
  fresh: CanonicalXmlInvoice,
  shareable: boolean,
): Promise<{ documentId: string; usedStoredXml: boolean }> {
  const existingXmlDoc = fresh.xrechnungDocument;
  const canonicalXmlDocumentId = fresh.xrechnungDocumentId;
  if (canonicalXmlDocumentId && existingXmlDoc?.versions[0]) {
    if (shareable && !existingXmlDoc.sharedWithClientAt) {
      await tx.document.updateMany({
        where: { id: existingXmlDoc.id, sharedWithClientAt: null },
        data: { sharedWithClientAt: new Date(), sharedByStaff: input.actorId },
      });
    }
    return { documentId: canonicalXmlDocumentId, usedStoredXml: false };
  }

  if (canonicalXmlDocumentId) {
    const detached = await tx.invoice.updateMany({
      where: { id: input.invoiceId, xrechnungDocumentId: canonicalXmlDocumentId },
      data: { xrechnungDocumentId: null },
    });
    if (detached.count !== 1) throw new Error('XRechnung-Link wurde parallel geändert.');
    await tx.document.updateMany({
      where: { id: canonicalXmlDocumentId, tenantId: input.ctx.tenantId, deletedAt: null },
      data: {
        deletedAt: new Date(),
        deletedByStaff: input.actorId,
        deleteReason: 'Kanonischer XRechnung-Link ohne Dokumentversion wurde ersetzt.',
        sharedWithClientAt: null,
        sharedByStaff: null,
      },
    });
  }

  const xmlDoc = await tx.document.create({
    data: {
      tenantId: input.ctx.tenantId,
      clientId: fresh.clientId,
      title: `Rechnung ${input.number} (XRechnung)`,
      classification: 'GOBD_INVOICE',
      mimeType: 'application/xml',
      retentionUntil: input.storedXml.retentionUntil,
      sharedWithClientAt: shareable ? new Date() : null,
      sharedByStaff: shareable ? input.actorId : null,
    },
  });
  await tx.documentVersion.create({
    data: {
      documentId: xmlDoc.id,
      versionNo: 1,
      storageBucket: input.storedXml.targetBucket,
      storageKey: input.storedXml.targetKey,
      storageVersionId: input.storedXml.storageVersionId,
      sha256: prismaBytes(input.storedXml.sha256),
      sizeBytes: input.storedXml.sizeBytes,
      immutable: input.storedXml.immutable,
      scanStatus: 'CLEAN',
      scanCompletedAt: new Date(),
      createdById: input.actorId,
    },
  });
  return { documentId: xmlDoc.id, usedStoredXml: true };
}

async function linkGeneratedArchiveTx(
  tx: TxClient,
  input: GeneratedArchiveLinkInput,
): Promise<ArchiveLinkResult> {
  await lockInvoiceArchiveTx(tx, input.invoiceId);
  const fresh = await tx.invoice.findFirst({
    where: { id: input.invoiceId, tenantId: input.ctx.tenantId },
    include: {
      document: { include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } } },
      xrechnungDocument: {
        include: { versions: { orderBy: { versionNo: 'desc' }, take: 1 } },
      },
    },
  });
  if (!fresh) return { outcome: 'not_found' };
  if (isCancelledDraft(fresh)) return { outcome: 'status_conflict' };

  const freshVersion = fresh.document?.versions[0];
  if (fresh.documentId && freshVersion) {
    const freshXmlVersion = fresh.xrechnungDocument?.versions[0];
    return {
      outcome: 'ready',
      bucket: freshVersion.storageBucket,
      key: freshVersion.storageKey,
      storageVersionId: freshVersion.storageVersionId,
      usedStoredPdf: false,
      usedStoredXml: false,
      needsCanonicalXml: !fresh.xrechnungDocumentId || !freshXmlVersion,
    };
  }

  const shareable = isInvoiceShareable(fresh);
  const doc = await tx.document.create({
    data: {
      tenantId: input.ctx.tenantId,
      clientId: fresh.clientId,
      title: `Rechnung ${input.number} (ZUGFeRD)`,
      classification: 'GOBD_INVOICE',
      mimeType: 'application/pdf',
      retentionUntil: input.stored.retentionUntil,
      sharedWithClientAt: shareable ? new Date() : null,
      sharedByStaff: shareable ? input.actorId : null,
    },
  });
  await tx.documentVersion.create({
    data: {
      documentId: doc.id,
      versionNo: 1,
      storageBucket: input.stored.targetBucket,
      storageKey: input.stored.targetKey,
      storageVersionId: input.stored.storageVersionId,
      sha256: prismaBytes(input.stored.sha256),
      sizeBytes: input.stored.sizeBytes,
      immutable: input.stored.immutable,
      scanStatus: 'CLEAN',
      scanCompletedAt: new Date(),
      createdById: input.actorId,
    },
  });

  await settleStorageIntentTx(tx, input.pdfIntent, input.stored);
  const canonicalXml = await ensureCanonicalXmlDocumentTx(tx, input, fresh, shareable);
  if (canonicalXml.usedStoredXml) {
    await settleStorageIntentTx(tx, input.xmlIntent, input.storedXml);
  }
  await tx.invoice.update({
    where: { id: input.invoiceId },
    data: {
      documentId: doc.id,
      xrechnungDocumentId: canonicalXml.documentId,
    },
  });
  await evidenceService.record(tx, {
    tenantId: input.ctx.tenantId,
    actorType: 'STAFF',
    actorId: input.actorId,
    action: 'invoice.archive.zugferd',
    resourceType: 'invoice',
    resourceId: input.invoiceId,
    after: {
      documentId: doc.id,
      xrechnungDocumentId: canonicalXml.documentId,
      number: input.number,
      sizeBytes: Number(input.stored.sizeBytes),
    },
  });
  return {
    outcome: 'ready',
    bucket: input.stored.targetBucket,
    key: input.stored.targetKey,
    storageVersionId: input.stored.storageVersionId,
    usedStoredPdf: true,
    usedStoredXml: canonicalXml.usedStoredXml,
    needsCanonicalXml: false,
  };
}

async function commitGeneratedArchiveLink(
  input: GeneratedArchiveLinkInput,
): Promise<ArchiveLinkResult> {
  try {
    return await withTenantContext(input.ctx, (tx) => linkGeneratedArchiveTx(tx, input));
  } catch (error) {
    await releaseStorageIntent({ intent: input.pdfIntent, commit: input.stored, cause: error });
    await releaseStorageIntent({ intent: input.xmlIntent, commit: input.storedXml, cause: error });
    throw error;
  }
}

async function finalizeGeneratedArchive(
  input: GeneratedArchiveLinkInput,
  result: ArchiveLinkResult,
  options: ArchiveOptions,
): Promise<ArchiveResult> {
  if (result.outcome !== 'ready') {
    const reason =
      result.outcome === 'status_conflict'
        ? 'Invoice was cancelled before archive linkage.'
        : 'Invoice disappeared before archive linkage.';
    await releaseUnusedArtifact(
      input.pdfIntent,
      input.stored,
      `invoice.archive.zugferd_unlinked: ${reason}`,
    );
    await releaseUnusedArtifact(
      input.xmlIntent,
      input.storedXml,
      `invoice.archive.xrechnung_unlinked: ${reason}`,
    );
    return { ok: false, code: result.outcome };
  }

  if (!result.usedStoredPdf) {
    await releaseUnusedArtifact(
      input.pdfIntent,
      input.stored,
      'invoice.archive.zugferd_race: Concurrent archive creation won before database commit.',
    );
  }
  if (!result.usedStoredXml) {
    const source = result.usedStoredPdf
      ? 'invoice.archive.xrechnung_already_exists'
      : 'invoice.archive.xrechnung_race';
    await releaseUnusedArtifact(
      input.xmlIntent,
      input.storedXml,
      `${source}: Stored XRechnung object was not referenced by the database transaction.`,
    );
  }
  if (result.needsCanonicalXml) {
    // Niemals das XML unseres möglicherweise abweichenden Snapshots anbinden;
    // nach Kompensation factur-x.xml bytegenau aus der Gewinner-PDF extrahieren.
    return ensureZugferdArchive(input.ctx, input.invoiceId, options);
  }
  return {
    ok: true,
    bucket: result.bucket,
    key: result.key,
    storageVersionId: result.storageVersionId,
    number: input.number,
  };
}

/**
 * Liefert die gespeicherte ZUGFeRD-Archiv-PDF einer Rechnung (idempotent).
 * Existiert noch keine, wird sie einmal generiert + revisionssicher abgelegt +
 * an die Rechnung verknüpft. Validierungsfehler (Adresse unvollständig) kommen
 * als Code zurück — NICHT als Throw (die Aufrufer mappen sie selbst). Nicht
 * darstellbare Zeichen werfen UnsupportedPdfTextError mit UI-tauglicher Meldung
 * (Zeichen und Feld, C5); andere Erzeugungsfehler bleiben technische Fehler.
 */
export async function ensureZugferdArchive(
  ctx: TenantContext,
  invoiceId: string,
  options: ArchiveOptions = {},
): Promise<ArchiveResult> {
  const actorId = ctx.actorId;
  if (!actorId) return { ok: false, code: 'not_found' };

  // 1. Rechnung (+ bestehendes Archiv) laden. Expliziter tenantId-Filter wie die
  //    Download-Routen (Defense in Depth gegen RLS-Drift bei Stammdaten-Belegen).
  const loaded = await loadArchiveInvoice(ctx, invoiceId);
  if (!loaded) return { ok: false, code: 'not_found' };
  // EXTERNAL (PDF) hat kein ZUGFeRD-Generat — deren documentId ist der Upload.
  if (!hasGeneratedEInvoice(loaded)) return { ok: false, code: 'not_applicable' };

  if ((options.purpose ?? 'ISSUE') === 'PREVIEW' && loaded.status === 'DRAFT') {
    return renderConsistentDraftPreview(ctx, invoiceId, loaded);
  }

  // Kontroll-Downloads aus älteren Versionen konnten DRAFT-Artefakte bereits
  // irreversibel ablegen. Beim tatsächlichen Ausstellen werden solche
  // ungeteilten Entwurfsarchive unter demselben Rechnungs-Lock gelöst und
  // ausgeblendet; anschließend entstehen PDF und XML gemeinsam aus dem
  // aktuellen Snapshot. Die Object-Lock-Bytes bleiben als Auditspur erhalten.
  if (loaded.status === 'DRAFT') {
    const preparation = await prepareDraftArchiveForIssue(ctx, invoiceId, actorId, loaded, options);
    if (preparation) return preparation;
  }

  // Bereits archiviert? → exakt dieselben Bytes wiederverwenden.
  const existing = await reuseExistingArchive(ctx, invoiceId, actorId, loaded);
  if (existing) return existing;

  // 2. Validierung (dieselbe Stammdatenprüfung wie die DRAFT-Vorschau beider
  // Download-Routen) — ohne sie würde nicht-konformes XML archiviert, daher
  // fail-closed.
  const seller = await readSellerInfo(ctx);
  const invalid = archiveInputFailure(loaded, seller);
  if (invalid) return { ok: false, code: invalid };

  // 3. Generieren (CPU — bewusst ausserhalb jeder DB-Tx). PDF und separate
  // XML stammen zwingend aus demselben semantischen Snapshot.
  const { pdfBytes, cii } = await generateInvoiceArtifacts(ctx, loaded, seller);

  // 4. Revisionssicher ablegen (GOBD-Tier, Object-Lock COMPLIANCE im GOBD-Bucket)
  //    — ebenfalls ausserhalb Tx. skipScan: App-eigene PDF (kein Nutzer-Upload),
  //    ClamAV ist hier sinnlos; die documentVersion wird mit scanStatus 'CLEAN' angelegt.
  //    K-06: PDF und XML stehen vor dem ersten PUT als Speicherabsichten im Journal.
  const artifacts = await storeInvoiceArtifacts(ctx, pdfBytes, cii);

  // 5. Die transaktionsgebundene Advisory-Sperre serialisiert Archivierung,
  // Versand und Storno. Übernommene Absichten werden in derselben Transaktion
  // abgeschlossen; verlierende bleiben für den Cleanup-Worker offen.
  const linkInput: GeneratedArchiveLinkInput = {
    ctx,
    invoiceId,
    actorId,
    number: loaded.number,
    ...artifacts,
  };
  const result = await commitGeneratedArchiveLink(linkInput);
  return finalizeGeneratedArchive(linkInput, result, options);
}
