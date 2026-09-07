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
  type ProtectionTier,
} from '@taxtronik/storage';
import { withTenantContext } from '@taxtronik/db';
import { notifyReminderAttachmentTx } from '@/server/reminders/service';
import {
  assertReminderUploadTx,
  ReminderUploadError,
} from '@/server/documents/reminder-upload-guard';
import {
  parseMultipartUpload,
  storageCommitErrorResponse,
  createDocumentWithVersion,
} from '@/server/documents/upload-helpers';
import { carrierClassification } from '@/server/storage/document-type';
import { evidenceService } from '@/server/container';
import { emitN8nEvent } from '@/server/n8n/emit';
import { log } from '@/server/logger';
import { compensateStorageCommit } from '@/server/documents/storage-compensation';

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
    reminderId: z.string().uuid().optional(),
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

  // Multipart-Body wird zentral am echten Stream begrenzt; das greift auch
  // ohne Content-Length und bei chunked Transfer-Encoding.
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
    reminderId: form.get('reminderId') ?? undefined,
    analysisId: form.get('analysisId') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation', issues: parsed.error.issues }, { status: 400 });
  }

  const { tenantId, staffId } = session.user;
  const { title, mimeType, clientId, folderId, workflowItemId, analysisId, reminderId } =
    parsed.data;

  // Typ → Schutzstufe + Carrier-Klassifikation + finale documentTypeId
  // auflösen (vor dem Storage-Commit, weil die Stufe Bucket/Lock bestimmt).
  // Befund 1a: auch die rein lesenden Referenz-Validierungen (clientId,
  // analysisId, workflowItemId, folderId) laufen HIER — vor dem Storage-
  // Commit. Ein object-locked Objekt kann nicht mehr gelöscht werden;
  // scheiterte die Validierung erst danach, blieb ein verwaistes Objekt.
  let tier: ProtectionTier;
  let classification: string;
  let retentionYears: number | undefined;
  let resolvedTypeId: string | null;
  let effectiveFolderId: string | null;
  try {
    const r = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        let resolved: {
          tier: ProtectionTier;
          classification: string;
          retentionYears?: number;
          resolvedTypeId: string | null;
        };
        if (parsed.data.documentTypeId) {
          const t = await tx.documentType.findFirst({
            where: { id: parsed.data.documentTypeId, tenantId, active: true },
            select: { id: true, tier: true, classificationKey: true, retentionYears: true },
          });
          if (!t) throw new Error('TYPE_NOT_FOUND: Datei-Typ nicht gefunden.');
          resolved = {
            tier: t.tier as ProtectionTier,
            classification: carrierClassification(t.tier as ProtectionTier, t.classificationKey),
            retentionYears: t.retentionYears ?? undefined,
            resolvedTypeId: t.id,
          };
        } else {
          // Back-Compat: Klassifikation gegeben → aktiven Kern-Typ desselben
          // Tenants verknüpfen und dessen Schutzstufe/Frist verwenden.
          const cls = parsed.data.classification!;
          const builtin = await tx.documentType.findFirst({
            where: { tenantId, classificationKey: cls, builtin: true, active: true },
            select: { id: true, tier: true, retentionYears: true },
          });
          resolved = {
            // Der Kern-Typ ist die fachliche Quelle fuer Schutzstufe und Frist.
            // Nur bei noch nicht provisionierten Alt-Tenants ohne Kern-Typ auf
            // die konservative Classification-Ableitung zurueckfallen.
            tier: builtin ? (builtin.tier as ProtectionTier) : classificationToTier(cls),
            classification: cls,
            retentionYears: builtin?.retentionYears ?? undefined,
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
          const a = await tx.riskAnalysis.findFirst({
            where: { id: analysisId },
            select: { id: true },
          });
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
        // Tenant- und Mandanten-Sanity für reminderId (analog workflowItemId).
        // Der FK prüft nur Existenz; unter RLS sieht findFirst nur Aufgaben
        // DIESES Tenants. Der Mandanten-Abgleich verhindert, dass ein Beleg
        // über eine bekannte UUID an eine Aufgabe eines anderen Mandanten
        // gehängt wird — eine interne Aufgabe (clientId null) nimmt
        // entsprechend nur kanzlei-interne Dateien auf.
        if (reminderId) {
          await assertReminderUploadTx(tx, session, reminderId, clientId ?? null);
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
    retentionYears = r.retentionYears;
    resolvedTypeId = r.resolvedTypeId;
    effectiveFolderId = r.effectiveFolderId;
  } catch (e) {
    return preflightErrorResponse(e, tenantId);
  }

  const fileData = Buffer.from(await file.arrayBuffer());

  // 1. Storage-Commit (Scan + Object-Lock-Upload, intern zu SeaweedFS) —
  // tier-getrieben (Bucket/Lock/Frist hängen an der Schutzstufe).
  let commit;
  try {
    commit = await commitBytesWithTier({
      fileData,
      tier,
      tenantId,
      classification,
      ...(tier === 'GOBD' && retentionYears ? { retentionYears } : {}),
    });
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
          const a = await tx.riskAnalysis.findFirst({
            where: { id: analysisId },
            select: { id: true },
          });
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
        if (reminderId) {
          try {
            await assertReminderUploadTx(tx, session, reminderId, clientId ?? null);
          } catch (error) {
            if (!(error instanceof ReminderUploadError)) throw error;
            throw referenceChanged('Wiedervorlage nicht mehr verfügbar oder bereits archiviert.');
          }
        }
        if (effectiveFolderId) {
          const f = await tx.documentFolder.findFirst({
            where: { id: effectiveFolderId, tenantId },
            select: { clientId: true },
          });
          finalFolderId =
            f && (f.clientId ?? null) === (clientId ?? null) ? effectiveFolderId : null;
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
            reminderId: reminderId ?? null,
            folderId: finalFolderId,
          },
          commit,
          createdById: staffId,
        });
        // Anhang einer Wiedervorlage: Beteiligte informieren (in derselben
        // Transaktion wie der Insert — kein Anhang ohne Meldung und umgekehrt).
        if (reminderId) {
          await notifyReminderAttachmentTx(tx, {
            tenantId,
            reminderId,
            documentId: document.id,
            documentTitle: title,
            uploadedBy: staffId,
          });
        }
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
    await compensateStorageCommit({
      tenantId,
      source: 'staff.document.commit',
      commit,
      cause: e,
    });
    if (isReferenceChanged(e)) {
      return NextResponse.json(
        {
          error: 'reference_changed',
          message: 'Referenz hat sich waehrend des Uploads geaendert.',
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  // 3. n8n-Event (fire-and-forget)
  await emitN8nEvent(
    'document.uploaded',
    {
      tenantId,
      documentId: docRow.id,
      classification,
      clientId: clientId ?? null,
      isGobd: isGobdClassification(classification),
    },
    { tenantId },
  );

  return NextResponse.json({
    ok: true,
    documentId: docRow.id,
    sha256: commit.sha256.toString('hex'),
    immutable: commit.immutable,
  });
}

/** Nur bekannte Validierungsfehler dürfen vor dem Store-Write ins UI gelangen. */
function preflightErrorResponse(error: unknown, tenantId: string): NextResponse {
  if (error instanceof ReminderUploadError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  const message = error instanceof Error ? error.message : '';
  const validationPrefixes = [
    'TYPE_NOT_FOUND',
    'CLIENT_NOT_FOUND',
    'ANALYSIS_NOT_FOUND',
    'WORKFLOW_ITEM_NOT_FOUND',
    'WORKFLOW_ITEM_CLIENT_MISMATCH',
  ];
  if (validationPrefixes.some((prefix) => message.startsWith(prefix))) {
    return NextResponse.json({ error: message }, { status: 400 });
  }
  log.error(
    { component: 'documents-commit', tenantId, err: message },
    'documents-commit: Validierungs-Tx vor Storage-Commit fehlgeschlagen',
  );
  return NextResponse.json({ error: 'internal_error' }, { status: 500 });
}
