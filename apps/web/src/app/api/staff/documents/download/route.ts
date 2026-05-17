// =============================================================================
// GET /api/staff/documents/download?ids=<uuid>,<uuid>,...
//
// Sammel-Download. Eine Datei → direkt (unkomprimiert). Mehrere → ZIP.
// Tenant-scoped (RLS + expliziter Filter), Audit pro Dokument.
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp } from '@/server/rate-limit';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { fetchObjectBytes, sanitizeFilenameForHeader } from '@taxtronik/storage';
import { filenameWithExtension } from '@/server/storage/preview-mime';
import { buildZip, sanitizeZipFileName, ZipTooLargeError, type ZipEntry } from '@/server/export/zip';
import { evidenceService } from '@/server/container';

export async function GET(req: NextRequest) {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { tenantId, staffId } = session.user;

  const ids = [
    ...new Set((req.nextUrl.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
  ].slice(0, 500);
  const folderIds = [
    ...new Set((req.nextUrl.searchParams.get('folders') ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
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
          select: { storageBucket: true, storageKey: true },
        },
      };

      const looseDocs = ids.length
        ? await tx.document.findMany({ where: { id: { in: ids }, tenantId }, select: sel })
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
            where: { tenantId, deletedAt: null, folderId: { in: [...subtree] } },
            select: sel,
          });
          folderDocs = inFolders
            .filter((d) => d.folderId)
            .map((d) => ({ doc: d, path: pathOf(d.folderId!) }));
        }
      }

      for (const d of [...looseDocs, ...folderDocs.map((x) => x.doc)]) {
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
      return { looseDocs, folderDocs };
    },
  );

  const usableLoose = looseDocs.filter((d) => d.versions[0]);
  const usableFolder = folderDocs.filter((x) => x.doc.versions[0]);
  if (usableLoose.length === 0 && usableFolder.length === 0) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Genau eine lose Datei, keine Ordner → unkomprimiert ausliefern.
  if (usableLoose.length === 1 && usableFolder.length === 0 && folderIds.length === 0) {
    const d = usableLoose[0]!;
    const v = d.versions[0]!;
    const bytes = await fetchObjectBytes(v.storageBucket, v.storageKey);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': d.mimeType || 'application/octet-stream',
        'content-disposition': `attachment; filename="${sanitizeFilenameForHeader(
          filenameWithExtension(d.title, d.mimeType),
        )}"`,
        'content-length': String(bytes.length),
        'cache-control': 'private, no-store',
      },
    });
  }

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

  let zip: Buffer;
  try {
    zip = buildZip(entries);
  } catch (e) {
    if (e instanceof ZipTooLargeError) {
      return NextResponse.json({ error: 'zip_too_large', message: e.message }, { status: 413 });
    }
    throw e;
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
