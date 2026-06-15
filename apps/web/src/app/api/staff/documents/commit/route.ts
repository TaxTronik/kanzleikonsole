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
import { env } from '@taxtronik/config';
import { getClientIp } from '@/server/rate-limit';
import { z } from 'zod';
import { staffAuth } from '@/server/auth/staff';
import { canAccessClientTx } from '@/server/auth/rbac';
import { assertSameOrigin } from '@/server/http/assert-same-origin';
import {
  commitBytesWithTier,
  classificationToTier,
  isGobdClassification,
  MAX_UPLOAD_BYTES,
  type ProtectionTier,
} from '@taxtronik/storage';
import { withTenantContext } from '@taxtronik/db';
import {
  parseMultipartUpload,
  storageCommitErrorResponse,
  createDocumentWithVersion,
} from '@/server/documents/upload-helpers';
import { carrierClassification } from '@/server/storage/document-type';
import { evidenceService } from '@/server/container';
import { emitN8nEvent } from '@/server/n8n/emit';
import { log } from '@/server/logger';

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
    analysisId: z.string().uuid().optional(),
  })
  .refine((d) => d.classification || d.documentTypeId, {
    message: 'classification oder documentTypeId erforderlich',
  });

const REFERENCE_CHANGED = 'REFERENCE_CHANGED';

function referenceChanged(message: string): Error {
  return new Error(`${REFERENCE_CHANGED}: ${message}`);
}

function isReferenceChanged(e: unknown): boolean {
  return ((e as Error).message ?? '').startsWith(REFERENCE_CHANGED);
}

export async function POST(req: NextRequest) {
  // CSRF-Defense-in-Depth (zusätzlich zu SameSite=lax): Cross-Origin-POSTs
  // ablehnen, bevor irgendetwas gepuffert oder authentifiziert wird.
  const csrf = assertSameOrigin(req, env.NEXTAUTH_URL);
  if (csrf) return csrf;

  const session = await staffAuth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // DoS-Mitigation: ehrlich deklarierte Über-Größe ablehnen, BEVOR req.formData()
  // den gesamten Body in den RAM puffert (+1 MB Marge für Multipart-Framing +
  // Metadatenfelder). Lügt der Client über Content-Length oder nutzt chunked-
  // Encoding, greift weiter unten der file.size-Check (dann ist gepuffert) —
  // voller Schutz wäre ein Streaming-Multipart-Parser (siehe Backlog).
  const declaredLen = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLen) && declaredLen > MAX_UPLOAD_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: 'TOO_LARGE' }, { status: 413 });
  }

  // Befund 12: Multipart-Parse + Datei-Checks zentral (upload-helpers).
  const upload = await parseMultipartUpload(req);
  if (!upload.ok) return upload.response;
  const { form, file } = upload;

  const parsed = FieldsSchema.safeParse({
    classification: form.get('classification') ?? undefined,
    documentTypeId: form.get('documentTypeId') ?? undefined,
    title: form.get('title'),
    mimeType: form.get('mimeType') ?? undefined,
    clientId: form.get('clientId') ?? undefined,
    folderId: form.get('folderId') ?? undefined,
    workflowItemId: form.get('workflowItemId') ?? undefined,
    analysisId: form.get('analysisId') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { tenantId, staffId } = session.user;
  const { title, mimeType, clientId, folderId, workflowItemId, analysisId } = parsed.data;

  // Typ → Schutzstufe + Carrier-Klassifikation + finale documentTypeId
  // auflösen (vor dem Storage-Commit, weil die Stufe Bucket/Lock bestimmt).
  // Befund 1a: auch die rein lesenden Referenz-Validierungen (clientId,
  // analysisId, workflowItemId, folderId) laufen HIER — vor dem Storage-
  // Commit. Ein object-locked Objekt kann nicht mehr gelöscht werden;
  // scheiterte die Validierung erst danach, blieb ein verwaistes Objekt.
  let tier: ProtectionTier;
  let classification: string;
  let resolvedTypeId: string | null;
  let effectiveFolderId: string | null;
  try {
    const r = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        let resolved: {
          tier: ProtectionTier;
          classification: string;
          resolvedTypeId: string | null;
        };
        if (parsed.data.documentTypeId) {
          const t = await tx.documentType.findFirst({
            where: { id: parsed.data.documentTypeId, tenantId, active: true },
            select: { id: true, tier: true, classificationKey: true },
          });
          if (!t) throw new Error('TYPE_NOT_FOUND: Datei-Typ nicht gefunden.');
          resolved = {
            tier: t.tier as ProtectionTier,
            classification: carrierClassification(t.tier as ProtectionTier, t.classificationKey),
            resolvedTypeId: t.id,
          };
        } else {
          // Back-Compat: Klassifikation gegeben → Kern-Typ desselben Tenants
          // verknüpfen, Stufe gesetzlich ableiten.
          const cls = parsed.data.classification!;
          const builtin = await tx.documentType.findFirst({
            where: { tenantId, classificationKey: cls },
            select: { id: true },
          });
          resolved = {
            tier: classificationToTier(cls),
            classification: cls,
            resolvedTypeId: builtin?.id ?? null,
          };
        }

        // M-1: Tenant-Sanity-Check für clientId — FK greift nur auf Existenz,
        // nicht auf Tenant-Match. Zugriffsmodell (vertraulich-Flag /
        // RESTRICTED): gesperrte Mandanten wie „nicht gefunden" behandeln
        // (kein Existenz-Leak) — kein Upload in fremde Mandanten-Akten.
        if (clientId) {
          const c = await tx.client.findFirst({ where: { id: clientId }, select: { id: true } });
          if (!c || !(await canAccessClientTx(tx, session, clientId))) {
            throw new Error('CLIENT_NOT_FOUND: clientId nicht in diesem Tenant.');
          }
        }
        // Tenant-Sanity für analysisId (analog clientId — der FK prüft nur Existenz,
        // unter RLS sieht findFirst nur Analysen DIESES Tenants).
        if (analysisId) {
          const a = await tx.riskAnalysis.findFirst({ where: { id: analysisId }, select: { id: true } });
          if (!a) {
            throw new Error('ANALYSIS_NOT_FOUND: analysisId nicht in diesem Tenant.');
          }
        }
        // HIGH: Tenant-/Mandanten-Sanity für workflowItemId. Der FK prüft nur
        // Existenz (workflow_item.id), nicht Tenant/Mandant — und workflow_item
        // trägt selbst keine tenant_id. Ohne diesen Check ließe sich mit bekannter
        // UUID ein Dokument an einen fremden Workflow-Schritt hängen, innerhalb
        // desselben Tenants auch mandantenübergreifend. Über die instance-Relation
        // (trägt tenantId + clientId) scopen und Mandanten-Gleichheit erzwingen.
        if (workflowItemId) {
          const wi = await tx.workflowItem.findFirst({
            where: { id: workflowItemId, instance: { tenantId } },
            select: { instance: { select: { clientId: true } } },
          });
          if (!wi) {
            throw new Error('WORKFLOW_ITEM_NOT_FOUND: workflowItemId nicht in diesem Tenant.');
          }
          if ((wi.instance.clientId ?? null) !== (clientId ?? null)) {
            throw new Error(
              'WORKFLOW_ITEM_CLIENT_MISMATCH: Workflow-Schritt gehört zu einem anderen Mandanten.',
            );
          }
        }
        // Ordner muss zum Tenant gehören und im selben Bereich liegen wie das
        // Dokument (Mandant ↔ Mandant, bzw. beide kanzlei-intern). Sonst
        // ignorieren (Dokument landet ohne Ordner) statt hart abzubrechen.
        let folder: string | null = null;
        if (folderId) {
          const f = await tx.documentFolder.findFirst({
            where: { id: folderId, tenantId },
            select: { clientId: true },
          });
          if (f && (f.clientId ?? null) === (clientId ?? null)) {
            folder = folderId;
          }
        }
        return { ...resolved, effectiveFolderId: folder };
      },
    );
    tier = r.tier;
    classification = r.classification;
    resolvedTypeId = r.resolvedTypeId;
    effectiveFolderId = r.effectiveFolderId;
  } catch (e) {
    // Bekannte Validierungsfehler → 400 mit Message; alles andere generisch
    // + strukturiertes Log (Policy rbac.ts: unbekannte Errors nie roh ans UI).
    const msg = (e as Error).message ?? '';
    const isValidation =
      msg.startsWith('TYPE_NOT_FOUND') ||
      msg.startsWith('CLIENT_NOT_FOUND') ||
      msg.startsWith('ANALYSIS_NOT_FOUND') ||
      msg.startsWith('WORKFLOW_ITEM_NOT_FOUND') ||
      msg.startsWith('WORKFLOW_ITEM_CLIENT_MISMATCH');
    if (isValidation) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    log.error(
      { component: 'documents-commit', tenantId, err: msg },
      'documents-commit: Validierungs-Tx vor Storage-Commit fehlgeschlagen',
    );
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  const fileData = Buffer.from(await file.arrayBuffer());

  // 1. Storage-Commit (Scan + Object-Lock-Upload, intern zu SeaweedFS) —
  // tier-getrieben (Bucket/Lock/Frist hängen an der Schutzstufe).
  let commit;
  try {
    commit = await commitBytesWithTier({ fileData, tier, tenantId });
  } catch (e) {
    // Befund 12: Mapping zentral (war 3× wortgleich kopiert).
    return storageCommitErrorResponse(e);
  }

  // 2. DB-Records + Audit in derselben Tx (Konsistenzgarantie). Die
  // Referenz-Validierungen liefen bereits VOR dem Storage-Commit (Befund 1a) —
  // hier nur noch Insert + Audit.
  let docRow;
  try {
    docRow = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        let finalFolderId = effectiveFolderId;

        if (clientId) {
          const c = await tx.client.findFirst({ where: { id: clientId }, select: { id: true } });
          if (!c || !(await canAccessClientTx(tx, session, clientId))) {
            throw referenceChanged('clientId nicht mehr gueltig oder nicht mehr zugaenglich.');
          }
        }
        if (analysisId) {
          const a = await tx.riskAnalysis.findFirst({ where: { id: analysisId }, select: { id: true } });
          if (!a) {
            throw referenceChanged('analysisId nicht mehr gueltig.');
          }
        }
        if (workflowItemId) {
          const wi = await tx.workflowItem.findFirst({
            where: { id: workflowItemId, instance: { tenantId } },
            select: { instance: { select: { clientId: true } } },
          });
          if (!wi || (wi.instance.clientId ?? null) !== (clientId ?? null)) {
            throw referenceChanged('workflowItemId nicht mehr gueltig oder Mandant geaendert.');
          }
        }
        if (effectiveFolderId) {
          const f = await tx.documentFolder.findFirst({
            where: { id: effectiveFolderId, tenantId },
            select: { clientId: true },
          });
          finalFolderId = f && (f.clientId ?? null) === (clientId ?? null) ? effectiveFolderId : null;
        }

        // M-2: detectedMime aus Magic-Bytes hat Vorrang vor Client-gemeldetem Wert.
        const effectiveMime = commit.detectedMime ?? mimeType;
        // Befund 12: Document+Version-Insert zentral (upload-helpers).
        const { document } = await createDocumentWithVersion(tx, {
          documentData: {
            tenantId,
            clientId: clientId ?? null,
            ownerStaffId: staffId,
            title,
            classification: classification as never,
            documentTypeId: resolvedTypeId,
            mimeType: effectiveMime,
            retentionUntil: commit.retentionUntil,
            workflowItemId: workflowItemId ?? null,
            analysisId: analysisId ?? null,
            folderId: finalFolderId,
          },
          commit,
          createdById: staffId,
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
  } catch (e) {
    // Befund 1: zu diesem Zeitpunkt liegt das Objekt bereits object-locked
    // im Storage und kann NICHT gelöscht werden. Scheitert die DB-Tx jetzt
    // noch (z. B. TOCTOU: Client zwischen Validierung und Insert gelöscht →
    // FK-Fehler), bleibt ein verwaistes Objekt zurück → Key strukturiert
    // loggen, damit Ops aufräumen/abgleichen kann.
    log.error(
      {
        component: 'documents-commit',
        tenantId,
        orphanedBucket: commit.targetBucket,
        orphanedKey: commit.targetKey,
        sha256: commit.sha256.toString('hex'),
        err: (e as Error).message,
      },
      'documents-commit: DB-Commit nach Storage-Upload fehlgeschlagen — Objekt verwaist',
    );
    if (isReferenceChanged(e)) {
      return NextResponse.json(
        { error: 'reference_changed', message: 'Referenz hat sich waehrend des Uploads geaendert.' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

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
