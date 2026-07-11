// =============================================================================
// Token-gestützte Auslieferung des zu unterzeichnenden PoA-PDFs an den externen
// Unterzeichner. Ausgeliefert wird ausschließlich der beim Versand gebundene
// Dokument-Snapshot.
//
// Zugriffsmodell = identisch zur Sign-Seite (loadPoaForSigning): nur der
// Signatur-Token (256-Bit-Secret in der Magic-Link-URL) autorisiert. Es wird
// AUSSCHLIESSLICH das eine, mit dieser Vollmacht verknüpfte Dokument
// ausgeliefert (scoped auf poa.tenantId + exakte documentId) — keine
// Enumeration, keine Cross-Tenant-Reads. Alle Fehlerfälle → generische 404
// (kein Token-Lebenszyklus-Leak).
//
// SICHERHEIT: Dieser Endpunkt liefert ein Dokument an einen NICHT
// eingeloggten Token-Inhaber aus. Vor Produktiv fachlich/security gegenlesen.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { getClientIp, checkIpOrGlobalLimit } from '@/server/rate-limit';
import { prismaOwner } from '@/server/db/prisma-owner';
import { streamObject } from '@taxtronik/storage';
import {
  effectiveDocumentMime,
  previewContentType,
  previewDisposition,
  previewSecurityHeaders,
} from '@/server/storage/preview-mime';
import {
  isPoaExpired,
  readPoaSigningSnapshot,
  snapshotDocumentMatches,
} from '@/server/poa/signing-snapshot';

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

// Frische Response je Aufruf — eine NextResponse-Instanz ist nur EINMAL
// konsumierbar und darf nicht über Requests wiederverwendet werden.
const notFound = () => NextResponse.json({ error: 'not_found' }, { status: 404 });

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  if (!token) return notFound();

  // Rate-Limit wie der unauthentifizierte Token-Lookup in loadPoaForSigning.
  const rl = await checkIpOrGlobalLimit(
    'poa-doc',
    getClientIp(req.headers),
    { max: 30, windowSec: 600 },
    { max: 200, windowSec: 600 },
  );
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });

  const owner = prismaOwner;
  const poa = await owner.powerOfAttorney.findFirst({
    where: { signingTokenHash: hashToken(token) },
  });
  // Generische 404 für ALLE Fälle (nicht gefunden / abgelaufen / falscher Status /
  // kein verknüpftes Dokument) — kein Information-Disclosure.
  if (!poa || !poa.documentId) return notFound();
  if (!poa.signingTokenExpiresAt || poa.signingTokenExpiresAt < new Date()) return notFound();
  if (poa.status !== 'SENT') return notFound();
  const snapshot = readPoaSigningSnapshot(poa.signingContentSnapshot, poa.signingContentSha256);
  if (!snapshot?.document || isPoaExpired(snapshot.validUntil)) return notFound();
  if (
    snapshot.document.documentId !== poa.documentId ||
    snapshot.document.versionId !== poa.signingDocumentVersionId
  ) {
    return notFound();
  }

  const version = await owner.documentVersion.findFirst({
    where: {
      id: snapshot.document.versionId,
      documentId: snapshot.document.documentId,
      document: { tenantId: poa.tenantId, deletedAt: null },
    },
    include: { document: true },
  });
  if (
    !version ||
    !snapshotDocumentMatches(snapshot, {
      id: version.id,
      documentId: version.documentId,
      sha256: version.sha256,
    })
  ) {
    return notFound();
  }
  const doc = version.document;

  // Sichere Inline-Auslieferung: effectiveDocumentMime liefert für ein
  // PoA-Dokument application/pdf; previewDisposition/-ContentType erzwingen die
  // Inline-Whitelist (Nicht-PDF würde als attachment heruntergeladen statt
  // gerendert — kein Stored-XSS).
  const mime = effectiveDocumentMime({
    mimeType: doc.mimeType,
    title: doc.title,
    classification: doc.classification,
    isPoaDocument: true,
  });
  const obj = await streamObject(version.storageBucket, version.storageKey);
  const headers: Record<string, string> = {
    'content-type': previewContentType(mime, doc.title),
    'content-disposition': previewDisposition(mime, doc.title),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    ...previewSecurityHeaders(mime, doc.title),
  };
  if (obj.contentLength !== null) headers['content-length'] = String(obj.contentLength);
  return new NextResponse(obj.body, { status: 200, headers });
}
