// =============================================================================
// GET /api/staff/documents/download?ids=<uuid>,<uuid>,...
//
// Sammel-Download. Eine Datei → direkt (unkomprimiert). Mehrere → ZIP.
// Tenant-scoped (RLS + expliziter Filter), Audit pro Dokument.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { inaccessibleClientIdsFor } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { fetchObjectBytes, streamObject, sanitizeFilenameForHeader } from '@taxtronik/storage';
import { filenameWithExtension } from '@/server/storage/preview-mime';
import {
  acquireZipBuildSlot,
  buildZip,
  sanitizeZipFileName,
  ZipBusyError,
  ZipTooLargeError,
  ZipTooManyEntriesError,
  ZIP_MAX_TOTAL_BYTES,
  type ZipEntry,
} from '@/server/export/zip';
import { evidenceService } from '@/server/container';
import { isUuid } from '@/lib/uuid';

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
    ...new Set((req.nextUrl.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter(isUuid)),
  ].slice(0, 500);
  const folderIds = [
    ...new Set((req.nextUrl.searchParams.get('folders') ?? '').split(',').map((s) => s.trim()).filter(isUuid)),
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
          select: { storageBucket: true, storageKey: true, sizeBytes: true },
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

  const usableLoose = looseDocs.filter((d) => d.versions[0]);
  const usableFolder = folderDocs.filter((x) => x.doc.versions[0]);
  if (usableLoose.length === 0 && usableFolder.length === 0) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Befund 15: Audit-Einträge erst NACH der Auslieferungsentscheidung
  // schreiben (vorher: bis zu 700 document.download-Einträge committet,
  // obwohl der Download anschließend mit 413 zip_too_large abgelehnt wurde —
  // der Audit-Trail behauptete Downloads, die nie stattfanden). Auditiert
  // werden nur Dokumente, die tatsächlich ausgeliefert werden (usable).
  const recordDownloadAudits = (docs: { id: string }[]) =>
    withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        for (const d of docs) {
          await evidenceService.record(tx, {
            tenantId,
            actorType: 'STAFF',
            actorId: staffId,
            action: 'document.download',
            resourceType: 'document',
            resourceId: d.id,
            ip: getClientIp(req.headers),
            userAgent: req.headers.get('user-agent'),
          });
        }
      },
    );

  // Genau eine lose Datei, keine Ordner → unkomprimiert durchstreamen (O(1)).
  if (usableLoose.length === 1 && usableFolder.length === 0 && folderIds.length === 0) {
    const d = usableLoose[0]!;
    const v = d.versions[0]!;
    await recordDownloadAudits([d]);
    const obj = await streamObject(v.storageBucket, v.storageKey);
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
  // ein Objekt geladen wird. Vorher holte die Route erst alle Bytes in den RAM und
  // buildZip cappte danach — der Speicher war da längst belegt. (Voller Streaming-
  // ZIP / Async-Export-Job für sehr große Sammlungen: siehe Backlog.)
  let totalBytes = 0n;
  for (const d of usableLoose) totalBytes += d.versions[0]!.sizeBytes;
  for (const x of usableFolder) totalBytes += x.doc.versions[0]!.sizeBytes;
  if (totalBytes > BigInt(ZIP_MAX_TOTAL_BYTES)) {
    const e = new ZipTooLargeError(Number(totalBytes), ZIP_MAX_TOTAL_BYTES);
    return NextResponse.json({ error: 'zip_too_large', message: e.message }, { status: 413 });
  }

  // Befund 15: Machbarkeit steht fest → jetzt auditieren, dann ausliefern.
  await recordDownloadAudits([...usableLoose, ...usableFolder.map((x) => x.doc)]);

  // P-6: Build-Slot — max. 2 parallele ZIP-Builds pro Instanz (RAM-Schutz),
  // umfasst Bytes-Laden UND buildZip (siehe server/export/zip.ts).
  let releaseZipSlot: () => void;
  try {
    releaseZipSlot = await acquireZipBuildSlot();
  } catch (e) {
    if (e instanceof ZipBusyError) {
      return NextResponse.json({ error: 'zip_busy', message: e.message }, { status: 429 });
    }
    throw e;
  }
  let zip: Buffer;
  try {
    // ZIP. Dubletten je Verzeichnis durchnummerieren.
    const seen = new Map<string, number>();
    const entries: ZipEntry[] = [];
    const addEntry = async (
      prefix: string,
      d: { title: string; mimeType: string; versions: { storageBucket: string; storageKey: string }[] },
    ) => {
      const v = d.versions[0]!;
      const bytes = await fetchObjectBytes(v.storageBucket, v.storageKey);
      let leaf = sanitizeZipFileName(filenameWithExtension(d.title, d.mimeType));
      const key = `${prefix}/${leaf}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      if (n > 0) {
        const dot = leaf.lastIndexOf('.');
        leaf = dot > 0 ? `${leaf.slice(0, dot)}_${n}${leaf.slice(dot)}` : `${leaf}_${n}`;
      }
      entries.push({ name: prefix ? `${prefix}/${leaf}` : leaf, data: bytes });
    };
    for (const d of usableLoose) await addEntry('', d);
    for (const x of usableFolder) await addEntry(x.path, x.doc);

    try {
      zip = buildZip(entries);
    } catch (e) {
      if (e instanceof ZipTooLargeError || e instanceof ZipTooManyEntriesError) {
        return NextResponse.json({ error: 'zip_too_large', message: e.message }, { status: 413 });
      }
      throw e;
    }
  } finally {
    releaseZipSlot();
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(new Uint8Array(zip), {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="dokumente_${stamp}.zip"`,
      'content-length': String(zip.length),
      'cache-control': 'private, no-store',
    },
  });
}
