// =============================================================================
// GET /api/staff/documents/download?ids=<uuid>,<uuid>,...
//
// Sammel-Download. Eine Datei → direkt (unkomprimiert). Mehrere → ZIP.
// Tenant-scoped (RLS + expliziter Filter). Abrufnachweis: Einzeldatei als
// `document.download`, ZIP als EIN `document.download.bulk` mit allen IDs.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { inaccessibleClientIdsFor } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { MAX_UPLOAD_BYTES, streamObject, sanitizeFilenameForHeader } from '@taxtronik/storage';
import { filenameWithExtension } from '@/server/storage/preview-mime';
import {
  acquireZipStreamSlot,
  createZipEntryPathAllocator,
  createZipStream,
  sanitizeZipFileName,
  ZipBusyError,
  ZipTooLargeError,
  ZipTooManyEntriesError,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_TOTAL_BYTES,
  type ZipStreamEntry,
} from '@/server/export/zip';
import { evidenceService } from '@/server/container';
import { isUuid } from '@/lib/uuid';
import { isDocumentVersionReady } from '@/server/documents/delivery-readiness';

export async function GET(req: NextRequest) {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { tenantId, staffId } = session.user;

  // Nur UUID-förmige Werte behalten: Nicht-UUID-Text ginge sonst in
  // `{ id: { in: ids } }` und würde von der @db.Uuid-Spalte mit P2023 → 500
  // quittiert (statt schlicht nichts zu matchen).
  const ids = [
    ...new Set(
      (req.nextUrl.searchParams.get('ids') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(isUuid),
    ),
  ].slice(0, 500);
  const folderIds = [
    ...new Set(
      (req.nextUrl.searchParams.get('folders') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(isUuid),
    ),
  ].slice(0, 200);
  if (ids.length === 0 && folderIds.length === 0) {
    return NextResponse.json({ error: 'no_ids' }, { status: 400 });
  }

  // looseDocs: ohne Ordner-Pfad (Zip-Wurzel). folderDocs: mit relativem
  // Pfad ab dem angeforderten Ordner.
  const { looseDocs, folderDocs } = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const sel = {
        id: true,
        title: true,
        mimeType: true,
        folderId: true,
        versions: {
          orderBy: { versionNo: 'desc' as const },
          take: 1,
          select: {
            storageBucket: true,
            storageKey: true,
            storageVersionId: true,
            sizeBytes: true,
            scanStatus: true,
            scanCompletedAt: true,
          },
        },
      };

      // Zugriffsmodell (vertraulich-Flag / RESTRICTED): Dokumente gesperrter
      // Mandanten aus dem Set filtern — auditiert werden nur die tatsächlich
      // gelieferten (usable*). clientId = null (Kanzlei-Dokumente) bleibt frei.
      const denied = await inaccessibleClientIdsFor(tx, session);
      const accessWhere = denied.length
        ? { OR: [{ clientId: null }, { clientId: { notIn: denied } }] }
        : {};

      const looseDocs = ids.length
        ? await tx.document.findMany({
            where: { id: { in: ids }, tenantId, deletedAt: null, ...accessWhere },
            select: sel,
          })
        : [];

      let folderDocs: { doc: (typeof looseDocs)[number]; path: string }[] = [];
      if (folderIds.length) {
        const allFolders = await tx.documentFolder.findMany({
          where: { tenantId },
          select: { id: true, name: true, parentId: true },
        });
        const byId = new Map(allFolders.map((f) => [f.id, f]));
        const childrenOf = new Map<string | null, string[]>();
        for (const f of allFolders) {
          childrenOf.set(f.parentId, [...(childrenOf.get(f.parentId) ?? []), f.id]);
        }
        // Pfad eines Ordners relativ zu einem der angeforderten Wurzel-Ordner.
        const reqSet = new Set(folderIds.filter((id) => byId.has(id)));
        const pathOf = (fid: string): string => {
          const parts: string[] = [];
          let cur: string | null = fid;
          let guard = 0;
          while (cur && guard++ < 100) {
            const f = byId.get(cur);
            if (!f) break;
            parts.unshift(sanitizeZipFileName(f.name, 60));
            if (reqSet.has(cur)) break; // ab Wurzel-Ordner nicht weiter hoch
            cur = f.parentId;
          }
          return parts.join('/');
        };
        // Alle Ordner im Teilbaum der angeforderten Ordner einsammeln.
        const subtree = new Set<string>();
        const stack = [...reqSet];
        while (stack.length) {
          const c = stack.pop()!;
          if (subtree.has(c)) continue;
          subtree.add(c);
          for (const k of childrenOf.get(c) ?? []) stack.push(k);
        }
        if (subtree.size) {
          const inFolders = await tx.document.findMany({
            where: { tenantId, deletedAt: null, folderId: { in: [...subtree] }, ...accessWhere },
            select: sel,
          });
          folderDocs = inFolders
            .filter((d) => d.folderId)
            .map((d) => ({ doc: d, path: pathOf(d.folderId!) }));
        }
      }

      return { looseDocs, folderDocs };
    },
  );

  const usableLoose = looseDocs.filter((d) => isDocumentVersionReady(d.versions[0]));
  const usableFolder = folderDocs.filter((x) => isDocumentVersionReady(x.doc.versions[0]));
  if (usableLoose.length === 0 && usableFolder.length === 0) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Befund 15: Audit-Einträge erst NACH der Auslieferungsentscheidung
  // schreiben (vorher: bis zu 700 document.download-Einträge committet,
  // obwohl der Download anschließend mit 413 zip_too_large abgelehnt wurde —
  // der Audit-Trail behauptete Downloads, die nie stattfanden). Auditiert
  // werden nur Dokumente, die tatsächlich ausgeliefert werden (usable).
  //
  // P-12: genau EIN Abrufnachweis pro Auslieferung. Ein ZIP-Export listet alle
  // enthaltenen Dokument-IDs in einem `document.download.bulk`-Ereignis. Vorher
  // entstand je Dokument ein `document.download`, jedes unter dem Tenant-Lock der
  // Hash-Kette bis zum Commit (2.000 Dateien ≈ 6.000 Statements, während derer
  // alle auditierten Schreibvorgänge der Kanzlei warteten). Die Liste bleibt
  // vollständig: Sie ist durch ZIP_MAX_ENTRIES begrenzt (≤ 65.535 IDs, rund
  // 2,5 MB JSON); packages/evidence kennt keine Größengrenze für `after`.
  const recordDownloadAudit = (delivery: 'file' | 'zip', documentIds: string[]) =>
    withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, (tx) =>
      evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: delivery === 'zip' ? 'document.download.bulk' : 'document.download',
        resourceType: 'document',
        resourceId: delivery === 'zip' ? null : documentIds[0],
        after:
          delivery === 'zip'
            ? { documentCount: documentIds.length, documentIds, folderIds }
            : undefined,
        ip: getClientIp(req.headers),
        userAgent: req.headers.get('user-agent'),
      }),
    );

  // Genau eine lose Datei, keine Ordner → unkomprimiert durchstreamen (O(1)).
  if (usableLoose.length === 1 && usableFolder.length === 0 && folderIds.length === 0) {
    const d = usableLoose[0]!;
    const v = d.versions[0]!;
    await recordDownloadAudit('file', [d.id]);
    const obj = await streamObject(v.storageBucket, v.storageKey, v.storageVersionId);
    const headers: Record<string, string> = {
      'content-type': d.mimeType || 'application/octet-stream',
      'content-disposition': `attachment; filename="${sanitizeFilenameForHeader(
        filenameWithExtension(d.title, d.mimeType),
      )}"`,
      'cache-control': 'private, no-store',
    };
    if (obj.contentLength !== null) headers['content-length'] = String(obj.contentLength);
    return new NextResponse(obj.body, { status: 200, headers });
  }

  // DoS-Mitigation: Gesamt-Größe AUS DER DB summieren und cappen, BEVOR auch nur
  // ein Objekt geladen wird. Seit P-03 wird das ZIP gestreamt; die Grenze ist
  // damit ein Produktlimit für Sync-Downloads (Async-Export-Job für sehr große
  // Sammlungen: siehe Backlog) und sichert das ZIP32-Format.
  let totalBytes = 0n;
  for (const d of usableLoose) totalBytes += d.versions[0]!.sizeBytes;
  for (const x of usableFolder) totalBytes += x.doc.versions[0]!.sizeBytes;
  if (totalBytes > BigInt(ZIP_MAX_TOTAL_BYTES)) {
    const e = new ZipTooLargeError(Number(totalBytes), ZIP_MAX_TOTAL_BYTES);
    return NextResponse.json({ error: 'zip_too_large', message: e.message }, { status: 413 });
  }
  // Die Eintragszahl steht ebenfalls vorab fest (vorher erst in buildZip, nach Audit).
  const entryCount = usableLoose.length + usableFolder.length;
  if (entryCount > ZIP_MAX_ENTRIES) {
    const e = new ZipTooManyEntriesError(entryCount, ZIP_MAX_ENTRIES);
    return NextResponse.json({ error: 'zip_too_large', message: e.message }, { status: 413 });
  }

  // P-6/P-03: Slot aus dem Pool für gestreamte Exporte (ZIP_MAX_PARALLEL_STREAMS).
  // Er bleibt belegt, bis das Archiv übertragen, fehlgeschlagen oder vom Client
  // abgebrochen ist (onSettled), nicht nur bis die Response zurückgeht.
  let releaseZipSlot: () => void;
  try {
    releaseZipSlot = await acquireZipStreamSlot();
  } catch (e) {
    if (e instanceof ZipBusyError) {
      return NextResponse.json({ error: 'zip_busy', message: e.message }, { status: 429 });
    }
    throw e;
  }
  try {
    // Befund 15 / F-18: Machbarkeit (Größe UND Build-Slot) steht fest → jetzt
    // auditieren, dann ausliefern. Vor dem Slot hätte ein 429 zip_busy einen
    // Abruf protokolliert, der nie stattfand. IDs in Archivreihenfolge; ein
    // zugleich einzeln und per Ordner gewähltes Dokument erscheint einmal.
    await recordDownloadAudit('zip', [
      ...new Set([...usableLoose.map((d) => d.id), ...usableFolder.map((x) => x.doc.id)]),
    ]);

    // P-03: Pfade vorab vergeben (Reihenfolge wie bisher: lose Dokumente, dann
    // Ordnerinhalte); die Objekte selbst öffnet erst der ZIP-Stream, eines nach
    // dem anderen, sobald der Client die vorherigen Bytes abgenommen hat.
    const allocatePath = createZipEntryPathAllocator(usableFolder.map((x) => x.path));
    const objects = [
      ...usableLoose.map((doc) => ({ prefix: '', doc })),
      ...usableFolder.map((x) => ({ prefix: x.path, doc: x.doc })),
    ].map(({ prefix, doc }) => ({
      name: allocatePath(prefix, filenameWithExtension(doc.title, doc.mimeType)),
      version: doc.versions[0]!,
    }));
    const body = createZipStream(storedObjectEntries(objects), {
      signal: req.signal,
      onSettled: releaseZipSlot,
      maxEntryBytes: MAX_UPLOAD_BYTES,
      maxSourceBytes: ZIP_MAX_TOTAL_BYTES,
    });

    const stamp = new Date().toISOString().slice(0, 10);
    // Ohne content-length: die Archivgröße steht erst nach dem Streamen fest.
    return new NextResponse(body, {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="dokumente_${stamp}.zip"`,
        'cache-control': 'private, no-store',
      },
    });
  } catch (e) {
    releaseZipSlot();
    throw e;
  }
}

/** P-03: Öffnet jedes Objekt erst, wenn der ZIP-Stream den Eintrag tatsächlich schreibt. */
async function* storedObjectEntries(
  objects: {
    name: string;
    version: { storageBucket: string; storageKey: string; storageVersionId: string | null };
  }[],
): AsyncGenerator<ZipStreamEntry> {
  for (const { name, version } of objects) {
    // DOC-VERSION-IMMUTABILITY-001: gebundene S3-Version, kein Key-Fallback.
    const object = await streamObject(
      version.storageBucket,
      version.storageKey,
      version.storageVersionId,
    );
    yield { name, data: object.body };
  }
}
