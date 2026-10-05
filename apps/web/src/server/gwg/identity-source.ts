import { createHash } from 'node:crypto';
import type { TxClient } from '@taxtronik/db';
import { fetchObjectBytes } from '@taxtronik/storage';
import { IdentityViewportsSchema, type IdentityViewport } from '@/lib/gwg/identity-viewport';
import { countIdentityPdfPages } from './identity-pdf-pages';

/**
 * F-05: Die gebundene Ausweisdatei war im Objektspeicher nicht lesbar (S3-/Netzfehler).
 * Das ist kein geänderter oder ungültiger Nachweis: Aufrufer dürfen ihn nicht als
 * Konflikt („Nachweis neu erfassen") melden, sondern als vorübergehenden Speicherfehler.
 */
export class IdentitySourceStorageError extends Error {
  constructor(cause: unknown) {
    super('Die Ausweisdatei konnte nicht aus dem Dokumentenspeicher gelesen werden.', { cause });
    this.name = 'IdentitySourceStorageError';
  }
}

export async function loadIdentitySourceTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    documentId: string;
  },
) {
  const document = await tx.document.findFirst({
    where: {
      id: input.documentId,
      tenantId: input.tenantId,
      clientId: input.clientId,
      classification: 'GWG_EVIDENCE',
      deletedAt: null,
      gwgDestroyedAt: null,
      gwgDestructionRequestedAt: null,
    },
    select: {
      id: true,
      title: true,
      mimeType: true,
      versions: {
        orderBy: { versionNo: 'desc' },
        take: 1,
        select: {
          id: true,
          storageBucket: true,
          storageKey: true,
          storageVersionId: true,
          scanStatus: true,
          scanCompletedAt: true,
          sha256: true,
          sizeBytes: true,
          pdfPageCount: true,
        },
      },
    },
  });
  const version = document?.versions[0];
  if (
    !document ||
    !version ||
    version.scanStatus !== 'CLEAN' ||
    !version.scanCompletedAt ||
    !version.storageVersionId ||
    version.sizeBytes > BigInt(25 * 1024 * 1024)
  )
    return null;
  return { documentId: document.id, title: document.title, mimeType: document.mimeType, version };
}
export type IdentitySource = NonNullable<Awaited<ReturnType<typeof loadIdentitySourceTx>>>;

export async function readIdentitySourceBytes(source: IdentitySource): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await fetchObjectBytes(
      source.version.storageBucket,
      source.version.storageKey,
      source.version.storageVersionId,
    );
  } catch (error) {
    throw new IdentitySourceStorageError(error);
  }
  const digest = createHash('sha256').update(bytes).digest();
  if (BigInt(bytes.length) !== source.version.sizeBytes || !digest.equals(source.version.sha256)) {
    throw new Error('Die Originaldatei stimmt nicht mit der gebundenen Version überein.');
  }
  return bytes;
}

const SOURCE_CHANGED =
  'Die Ausweisdatei wurde geändert oder ist nicht verfügbar. Bitte neu auswählen.';
const PDF_UNREADABLE =
  'Die PDF-Datei der Ausweisquelle konnte nicht gelesen werden (beschädigt, verschlüsselt oder zu komplex).';
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * P-13: Seitenzahl einer PDF-Quelle ohne beim Upload gespeicherten Wert,
 * außerhalb jeder Transaktion ermittelt (Download, Hashprüfung, begrenzter
 * Worker-Thread). `outcome` enthält entweder die Seitenzahl oder den Fehler,
 * den die Prüfung in der Transaktion an derselben Stelle wirft wie bisher
 * (Speicherfehler, Hashabweichung, nicht lesbare PDF).
 */
export interface IdentityPdfPageCountProbe {
  versionId: string;
  sha256: Buffer;
  outcome: { ok: true; pages: number } | { ok: false; error: Error };
}
/** Vorab ermittelte Seitenzahlen je Dokumentversion (Schlüssel: Version-ID). */
export type IdentityPdfPageCounts = ReadonlyMap<string, IdentityPdfPageCountProbe>;
export const NO_IDENTITY_PDF_PAGE_COUNTS: IdentityPdfPageCounts = new Map();

/** Ausweisansichten einer Datei, wie sie die Transaktion anschließend prüft. */
export interface IdentityViewSelection {
  documentId: string;
  views: unknown;
}

/**
 * Manueller Verweis auf das ganze Original (Seite 1, voller Ausschnitt, keine
 * Drehung): braucht keine PDF-Dekodierung. Ausschnitte, Drehung und
 * Folgeseiten werden gegen die Seitenzahl der Quelle geprüft.
 */
function isManualOriginal(views: IdentityViewport[]): boolean {
  return views.every(
    (view) =>
      view.page === 1 &&
      view.x === 0 &&
      view.y === 0 &&
      view.width === 1 &&
      view.height === 1 &&
      view.rotation === 0,
  );
}

/** Ob diese Ansichten bei einer PDF-Quelle eine Seitenprüfung brauchen (ohne DB-Zugriff). */
export function identityViewsNeedPageCheck(views: unknown): boolean {
  const parsed = IdentityViewportsSchema.safeParse(views);
  return parsed.success && parsed.data.length > 0 && !isManualOriginal(parsed.data);
}

/** Liest die Quellen der Auswahl, deren Ansichten eine Seitenprüfung brauchen. */
export async function loadIdentitySourcesForPageCheckTx(
  tx: TxClient,
  scope: { tenantId: string; clientId: string },
  selections: readonly IdentityViewSelection[],
): Promise<Array<{ source: IdentitySource | null; views: unknown }>> {
  const candidates = [];
  for (const selection of selections) {
    if (!identityViewsNeedPageCheck(selection.views)) continue;
    candidates.push({
      source: await loadIdentitySourceTx(tx, { ...scope, documentId: selection.documentId }),
      views: selection.views,
    });
  }
  return candidates;
}

export async function probeIdentityPdfPageCount(
  source: IdentitySource,
): Promise<IdentityPdfPageCountProbe> {
  const probe = { versionId: source.version.id, sha256: Buffer.from(source.version.sha256) };
  let bytes: Buffer;
  try {
    bytes = await readIdentitySourceBytes(source);
  } catch (error) {
    return { ...probe, outcome: { ok: false, error: error as Error } };
  }
  const pages = await countIdentityPdfPages(bytes);
  return {
    ...probe,
    outcome: pages === null ? { ok: false, error: new Error(PDF_UNREADABLE) } : { ok: true, pages },
  };
}

/**
 * P-13: Vorbereitung vor der gesperrten Transaktion. `readCandidates` liest in
 * einer kurzen, autorisierten Lesetransaktion die Quellen (z. B.
 * loadIdentitySourcesForPageCheckTx); gezählt werden danach ohne Transaktion
 * nur PDF-Quellen ohne beim Upload gespeicherte Seitenzahl. Fehler dieser
 * Vorbereitung entscheiden nichts: Ohne Ergebnis lehnt die Transaktion, die
 * Zugriff, Status und Quelle erneut prüft, einen solchen Ausschnitt als
 * geänderte Quelle ab.
 */
export async function prepareIdentityPdfPageCounts(
  readCandidates: () => Promise<
    ReadonlyArray<{ source: IdentitySource | null; views: unknown }> | null | undefined
  >,
): Promise<IdentityPdfPageCounts> {
  let candidates: ReadonlyArray<{ source: IdentitySource | null; views: unknown }>;
  try {
    candidates = (await readCandidates()) ?? [];
  } catch {
    return NO_IDENTITY_PDF_PAGE_COUNTS;
  }
  const probes = new Map<string, IdentityPdfPageCountProbe>();
  for (const { source, views } of candidates) {
    const parsed = IdentityViewportsSchema.safeParse(views);
    if (
      !source ||
      !parsed.success ||
      probes.has(source.version.id) ||
      source.mimeType !== 'application/pdf' ||
      typeof source.version.pdfPageCount === 'number' ||
      parsed.data.length === 0 ||
      parsed.data.some((view) => view.versionId !== source.version.id) ||
      isManualOriginal(parsed.data)
    ) {
      continue;
    }
    // Nacheinander: höchstens eine Originaldatei samt Parser gleichzeitig im Speicher.
    probes.set(source.version.id, await probeIdentityPdfPageCount(source));
  }
  return probes;
}

/**
 * In der Transaktion nur Version-ID und SHA-256 vergleichen: Die Seitenzahl
 * stammt vom Upload derselben Version oder aus der Vorabzählung genau dieser
 * Version und dieses Hashs.
 */
function pdfPageCountTx(source: IdentitySource, pageCounts: IdentityPdfPageCounts): number {
  const stored = source.version.pdfPageCount;
  if (typeof stored === 'number') return stored;
  const probe = pageCounts.get(source.version.id);
  if (!probe || !probe.sha256.equals(source.version.sha256)) throw new Error(SOURCE_CHANGED);
  if (!probe.outcome.ok) throw probe.outcome.error;
  return probe.outcome.pages;
}

/**
 * GWG-IDENTIFICATION-EVIDENCE-001: caller must hold document/lifecycle locks.
 * P-13: liest keine Bytes und parst nichts; PDF-Seitenzahlen kommen vom Upload
 * oder aus prepareIdentityPdfPageCounts (vor der Transaktion).
 */
export async function validateIdentityViewportsTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    documentId: string;
    views: IdentityViewport[];
  },
  pageCounts: IdentityPdfPageCounts,
): Promise<IdentityViewport[]> {
  const views = IdentityViewportsSchema.parse(input.views);
  if (!views.length) return [];
  const source = await loadIdentitySourceTx(tx, input);
  if (!source || views.some((view) => view.versionId !== source.version.id)) {
    throw new Error(SOURCE_CHANGED);
  }
  let pages = 1;
  if (source.mimeType === 'application/pdf') {
    if (!isManualOriginal(views)) pages = pdfPageCountTx(source, pageCounts);
  } else if (!IMAGE_TYPES.includes(source.mimeType)) {
    throw new Error('Ausschnitte sind nur bei JPG, PNG und PDF verfügbar.');
  }
  if (views.some((view) => view.page > pages))
    throw new Error('Die gewählte PDF-Seite existiert nicht.');
  return views;
}
