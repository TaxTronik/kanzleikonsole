// =============================================================================
// POST /api/staff/documents/commit
//
// App-proxied Upload (kein presigned-direct mehr): der Browser POSTet die
// Datei als multipart/form-data an diese Route. Die App streamt sie intern
// zu SeaweedFS — der Object-Store ist NIE öffentlich erreichbar (§ 203 StGB:
// minimale Angriffsfläche on-prem).
//
// Schritte:
//   1. multipart-Body → Buffer
//   2. commitDocumentFromBytes: ClamAV-Scan + SHA-256 + Object-Lock-Upload
//   3. Document + DocumentVersion in DB (Tenant-Kontext via RLS)
//   4. Audit-Eintrag (hash-chained) via EvidenceService
//   5. n8n-Webhook `document.uploaded` (fire-and-forget)
//
// FormData-Felder: file (Blob), classification, title, mimeType?,
//                   clientId? (UUID), workflowItemId? (UUID)
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp } from '@/server/rate-limit';
import { z } from 'zod';
import { staffAuth } from '@/server/auth/staff';
import {
  commitBytesWithTier,
  classificationToTier,
  isGobdClassification,
  MAX_UPLOAD_BYTES,
  type ProtectionTier,
} from '@taxtronik/storage';
import { withTenantContext } from '@taxtronik/db';
import { carrierClassification } from '@/server/storage/document-type';
import { evidenceService } from '@/server/container';
import { emitN8nEvent } from '@/server/n8n/emit';

// iter55: bevorzugt documentTypeId (trägt die Schutzstufe). classification
// bleibt als Back-Compat erlaubt (Altpfade / Kern-Typ direkt). Mindestens
// eines von beiden muss da sein.
const FieldsSchema = z
  .object({
    classification: z
      .enum([
        'GOBD_INVOICE',
        'GOBD_CONTRACT',
        'GOBD_TAX',
        'GWG_EVIDENCE',
        'PERSONNEL',
        'STAFF_PRIVATE',
        'GENERAL',
      ])
      .optional(),
    documentTypeId: z.string().uuid().optional(),
    title: z.string().min(1).max(500),
    mimeType: z.string().min(1).max(255).default('application/octet-stream'),
    clientId: z.string().uuid().optional(),
    folderId: z.string().uuid().optional(),
    workflowItemId: z.string().uuid().optional(),
  })
  .refine((d) => d.classification || d.documentTypeId, {
    message: 'classification oder documentTypeId erforderlich',
  });

export async function POST(req: NextRequest) {
  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_multipart' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: 'file_missing' }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: 'TOO_LARGE' }, { status: 413 });
  }

  const parsed = FieldsSchema.safeParse({
    classification: form.get('classification') ?? undefined,
    documentTypeId: form.get('documentTypeId') ?? undefined,
    title: form.get('title'),
    mimeType: form.get('mimeType') ?? undefined,
    clientId: form.get('clientId') ?? undefined,
    folderId: form.get('folderId') ?? undefined,
    workflowItemId: form.get('workflowItemId') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { tenantId, staffId } = session.user;
  const { title, mimeType, clientId, folderId, workflowItemId } = parsed.data;

  // Typ → Schutzstufe + Carrier-Klassifikation + finale documentTypeId
  // auflösen (vor dem Storage-Commit, weil die Stufe Bucket/Lock bestimmt).
  let tier: ProtectionTier;
  let classification: string;
  let resolvedTypeId: string | null;
  try {
    const r = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        if (parsed.data.documentTypeId) {
          const t = await tx.documentType.findFirst({
            where: { id: parsed.data.documentTypeId, tenantId, active: true },
            select: { id: true, tier: true, classificationKey: true },
          });
          if (!t) throw new Error('TYPE_NOT_FOUND: Datei-Typ nicht gefunden.');
          return {
            tier: t.tier as ProtectionTier,
            classification: carrierClassification(t.tier as ProtectionTier, t.classificationKey),
            resolvedTypeId: t.id,
          };
        }
        // Back-Compat: Klassifikation gegeben → Kern-Typ desselben Tenants
        // verknüpfen, Stufe gesetzlich ableiten.
        const cls = parsed.data.classification!;
        const builtin = await tx.documentType.findFirst({
          where: { tenantId, classificationKey: cls },
          select: { id: true },
        });
        return {
          tier: classificationToTier(cls),
          classification: cls,
          resolvedTypeId: builtin?.id ?? null,
        };
      },
    );
    tier = r.tier;
    classification = r.classification;
    resolvedTypeId = r.resolvedTypeId;
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const fileData = Buffer.from(await file.arrayBuffer());

  // 1. Storage-Commit (Scan + Object-Lock-Upload, intern zu SeaweedFS) —
  // tier-getrieben (Bucket/Lock/Frist hängen an der Schutzstufe).
  let commit;
  try {
    commit = await commitBytesWithTier({ fileData, tier, tenantId });
  } catch (e) {
    const msg = (e as Error).message;
    const status =
      msg.startsWith('INFECTED') ? 422 :
      msg.startsWith('TOO_LARGE') ? 413 :
      msg.startsWith('FORBIDDEN') ? 403 :
      msg.startsWith('SCAN_ERROR') ? 502 : 500;
    return NextResponse.json({ error: msg }, { status });
  }

  // 2. DB-Records + Audit in derselben Tx (Konsistenzgarantie)
  const docRow = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // M-1: Tenant-Sanity-Check für clientId — FK greift nur auf Existenz,
      // nicht auf Tenant-Match.
      if (clientId) {
        const c = await tx.client.findFirst({ where: { id: clientId }, select: { id: true } });
        if (!c) {
          throw new Error('CLIENT_NOT_FOUND: clientId nicht in diesem Tenant.');
        }
      }
      // Ordner muss zum Tenant gehören und im selben Bereich liegen wie das
      // Dokument (Mandant ↔ Mandant, bzw. beide kanzlei-intern). Sonst
      // ignorieren (Dokument landet ohne Ordner) statt hart abzubrechen.
      let effectiveFolderId: string | null = null;
      if (folderId) {
        const f = await tx.documentFolder.findFirst({
          where: { id: folderId, tenantId },
          select: { clientId: true },
        });
        if (f && (f.clientId ?? null) === (clientId ?? null)) {
          effectiveFolderId = folderId;
        }
      }
      // M-2: detectedMime aus Magic-Bytes hat Vorrang vor Client-gemeldetem Wert.
      const effectiveMime = commit.detectedMime ?? mimeType;
      const document = await tx.document.create({
        data: {
          tenantId,
          clientId: clientId ?? null,
          ownerStaffId: staffId,
          title,
          classification: classification as never,
          documentTypeId: resolvedTypeId,
          mimeType: effectiveMime,
          retentionUntil: commit.retentionUntil,
          workflowItemId: workflowItemId ?? null,
          folderId: effectiveFolderId,
        },
      });
      await tx.documentVersion.create({
        data: {
          documentId: document.id,
          versionNo: 1,
          storageBucket: commit.targetBucket,
          storageKey: commit.targetKey,
          sha256: commit.sha256,
          sizeBytes: commit.sizeBytes,
          immutable: commit.immutable,
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
          createdById: staffId,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'document.upload',
        resourceType: 'document',
        resourceId: document.id,
        after: {
          title,
          classification,
          clientId: clientId ?? null,
          sha256: commit.sha256.toString('hex'),
          immutable: commit.immutable,
        },
        ip: getClientIp(req.headers),
        userAgent: req.headers.get('user-agent'),
      });
      return document;
    },
  );

  // 3. n8n-Event (fire-and-forget)
  emitN8nEvent('document.uploaded', {
    tenantId,
    documentId: docRow.id,
    classification,
    clientId: clientId ?? null,
    isGobd: isGobdClassification(classification),
  });

  return NextResponse.json({
    ok: true,
    documentId: docRow.id,
    sha256: commit.sha256.toString('hex'),
    immutable: commit.immutable,
  });
}
