// =============================================================================
// POST /api/staff/documents/commit
//
// App-proxied Upload (kein presigned-direct mehr): der Browser POSTet die
// Datei als multipart/form-data an diese Route. Die App streamt sie intern
// zu SeaweedFS — der Object-Store ist NIE öffentlich erreichbar (§ 203 StGB:
// minimale Angriffsfläche on-prem).
//
// Schritte (Journal-first, K-06 / DOC-UPLOAD-JOURNAL-001):
//   1. multipart-Body (zentral am Stream begrenzt)
//   2. Vorprüfung (Typ → Schutzstufe, Mandant, Analyse, Workflow-Schritt,
//      Wiedervorlage, Ordner) — vor Scan, Journal und Object-Write
//   3. ClamAV-Scan + SHA-256 + fester Schlüssel, Speicherabsicht journalisieren
//   4. Object-Lock-Upload genau dieser Absicht
//   5. dieselbe Prüfung erneut + Document/DocumentVersion + Audit in einer Tx
//   6. n8n-Webhook `document.uploaded` (fire-and-forget)
//
// FormData-Felder: file (Blob), classification, title, mimeType?,
//                   clientId? (UUID), workflowItemId? (UUID)
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@taxtronik/config';
import { getClientIp } from '@/server/rate-limit';
import { z } from 'zod';
import { staffAuth, type StaffSession } from '@/server/auth/staff';
import { canAccessClientTx } from '@/server/auth/rbac';
import { assertSameOrigin } from '@/server/http/assert-same-origin';
import {
  classificationToTier,
  isGobdClassification,
  type ProtectionTier,
} from '@taxtronik/storage';
import type { TxClient } from '@taxtronik/db';
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
import { JournaledUploadError, runJournaledUpload } from '@/server/documents/journaled-upload';
import { carrierClassification } from '@/server/storage/document-type';
import { identityPdfPageCountForUpload } from '@/server/gwg/identity-pdf-pages';
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
    reminderId: z.string().uuid().optional(),
    analysisId: z.string().uuid().optional(),
  })
  .refine((d) => d.classification || d.documentTypeId, {
    message: 'classification oder documentTypeId erforderlich',
  });

type UploadFields = z.infer<typeof FieldsSchema>;

/** Ergebnis der gemeinsamen Vor- und Nachprüfung eines Staff-Uploads. */
interface StaffUploadCheck {
  tier: ProtectionTier;
  classification: string;
  retentionYears?: number;
  resolvedTypeId: string | null;
  folderId: string | null;
}

class ReferenceChangedError extends Error {
  constructor(message: string) {
    super(`REFERENCE_CHANGED: ${message}`);
  }
}

type UploadValidationCode =
  | 'TYPE_NOT_FOUND'
  | 'CLIENT_NOT_FOUND'
  | 'ANALYSIS_NOT_FOUND'
  | 'WORKFLOW_ITEM_NOT_FOUND'
  | 'WORKFLOW_ITEM_CLIENT_MISMATCH';

/**
 * Bekannte Ablehnung der Upload-Prüfung. F-03: eingeordnet über die Klasse statt
 * über Meldungspräfixe; die Meldung behält das Format `CODE: …` für das UI.
 */
class UploadValidationError extends Error {
  constructor(
    readonly code: UploadValidationCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'UploadValidationError';
  }
}

/** Typ → Schutzstufe + Carrier-Klassifikation + finale documentTypeId. */
async function resolveUploadTypeTx(
  tx: TxClient,
  tenantId: string,
  fields: UploadFields,
): Promise<Omit<StaffUploadCheck, 'folderId'>> {
  if (fields.documentTypeId) {
    const t = await tx.documentType.findFirst({
      where: { id: fields.documentTypeId, tenantId, active: true },
      select: { id: true, tier: true, classificationKey: true, retentionYears: true },
    });
    if (!t) throw new UploadValidationError('TYPE_NOT_FOUND', 'Datei-Typ nicht gefunden.');
    return {
      tier: t.tier as ProtectionTier,
      classification: carrierClassification(t.tier as ProtectionTier, t.classificationKey),
      retentionYears: t.retentionYears ?? undefined,
      resolvedTypeId: t.id,
    };
  }
  // Back-Compat: Klassifikation gegeben → aktiven Kern-Typ desselben
  // Tenants verknüpfen und dessen Schutzstufe/Frist verwenden.
  const cls = fields.classification!;
  const builtin = await tx.documentType.findFirst({
    where: { tenantId, classificationKey: cls, builtin: true, active: true },
    select: { id: true, tier: true, retentionYears: true },
  });
  return {
    // Der Kern-Typ ist die fachliche Quelle fuer Schutzstufe und Frist.
    // Nur bei noch nicht provisionierten Alt-Tenants ohne Kern-Typ auf
    // die konservative Classification-Ableitung zurueckfallen.
    tier: builtin ? (builtin.tier as ProtectionTier) : classificationToTier(cls),
    classification: cls,
    retentionYears: builtin?.retentionYears ?? undefined,
    resolvedTypeId: builtin?.id ?? null,
  };
}

/**
 * Gemeinsame Vor- und Nachprüfung (K-06). Befund 1a: Die Referenzen werden vor
 * dem Store-Write geprüft — ein object-locked Objekt ist nicht mehr löschbar.
 * Dieselbe Prüfung läuft erneut in der Commit-Transaktion; dort muss die
 * Typauflösung unverändert sein, sonst passen Lock und Metadaten nicht mehr.
 */
async function checkStaffUploadTx(
  tx: TxClient,
  session: StaffSession,
  fields: UploadFields,
  pre?: StaffUploadCheck,
): Promise<StaffUploadCheck> {
  const tenantId = session.user.tenantId;
  const { clientId, analysisId, workflowItemId, reminderId, folderId } = fields;
  const resolved = await resolveUploadTypeTx(tx, tenantId, fields);
  if (
    pre &&
    (resolved.tier !== pre.tier ||
      resolved.classification !== pre.classification ||
      resolved.retentionYears !== pre.retentionYears ||
      resolved.resolvedTypeId !== pre.resolvedTypeId)
  ) {
    throw new ReferenceChangedError('Datei-Typ wurde während des Uploads geändert.');
  }

  // M-1: Tenant-Sanity-Check für clientId — FK greift nur auf Existenz,
  // nicht auf Tenant-Match. Zugriffsmodell (vertraulich-Flag /
  // RESTRICTED): gesperrte Mandanten wie „nicht gefunden" behandeln
  // (kein Existenz-Leak) — kein Upload in fremde Mandanten-Akten.
  if (clientId) {
    const c = await tx.client.findFirst({ where: { id: clientId }, select: { id: true } });
    if (!c || !(await canAccessClientTx(tx, session, clientId))) {
      throw new UploadValidationError('CLIENT_NOT_FOUND', 'clientId nicht in diesem Tenant.');
    }
  }
  // Tenant-Sanity für analysisId (analog clientId — der FK prüft nur Existenz,
  // unter RLS sieht findFirst nur Analysen DIESES Tenants).
  if (analysisId) {
    const a = await tx.riskAnalysis.findFirst({ where: { id: analysisId }, select: { id: true } });
    if (!a) {
      throw new UploadValidationError('ANALYSIS_NOT_FOUND', 'analysisId nicht in diesem Tenant.');
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
      throw new UploadValidationError(
        'WORKFLOW_ITEM_NOT_FOUND',
        'workflowItemId nicht in diesem Tenant.',
      );
    }
    if ((wi.instance.clientId ?? null) !== (clientId ?? null)) {
      throw new UploadValidationError(
        'WORKFLOW_ITEM_CLIENT_MISMATCH',
        'Workflow-Schritt gehört zu einem anderen Mandanten.',
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
    if (f && (f.clientId ?? null) === (clientId ?? null)) folder = folderId;
  }
  return { ...resolved, folderId: folder };
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
  const fields = parsed.data;
  const { title, mimeType, clientId, workflowItemId, analysisId, reminderId } = fields;
  // P-13: Seitenzahl einer PDF-Ausweisquelle einmalig aus genau diesen Bytes
  // (begrenzter Worker-Thread, nur GWG_EVIDENCE) — nach dem Scan, vor dem
  // Object-Write, damit das Fenster zwischen Write und DB-Insert nicht wächst.
  let pdfPageCount: number | null = null;

  let stored;
  try {
    stored = await runJournaledUpload({
      context: { tenantId, actorId: staffId, actorType: 'STAFF' },
      source: 'staff.document.commit',
      readBytes: async () => Buffer.from(await file.arrayBuffer()),
      check: (tx: TxClient, _phase: 'pre' | 'post', pre?: StaffUploadCheck) =>
        checkStaffUploadTx(tx, session, fields, pre),
      // tier-getrieben: Bucket/Lock/Frist hängen an der Schutzstufe.
      storage: (checked) => ({
        tier: checked.tier,
        classification: checked.classification,
        ...(checked.tier === 'GOBD' && checked.retentionYears
          ? { retentionYears: checked.retentionYears }
          : {}),
      }),
      afterPrepare: async ({ bytes, checked }) => {
        pdfPageCount = await identityPdfPageCountForUpload({
          classification: checked.classification,
          mimeType,
          bytes,
        });
      },
      commitTx: async (tx, { commit, checked }) => {
        // M-2: detectedMime aus Magic-Bytes hat Vorrang vor Client-gemeldetem Wert.
        const effectiveMime = commit.detectedMime ?? mimeType;
        // Befund 12: Document+Version-Insert zentral (upload-helpers).
        const { document } = await createDocumentWithVersion(tx, {
          documentData: {
            tenantId,
            clientId: clientId ?? null,
            ownerStaffId: staffId,
            title,
            classification: checked.classification as never,
            documentTypeId: checked.resolvedTypeId,
            mimeType: effectiveMime,
            retentionUntil: commit.retentionUntil,
            workflowItemId: workflowItemId ?? null,
            analysisId: analysisId ?? null,
            reminderId: reminderId ?? null,
            folderId: checked.folderId,
          },
          commit,
          createdById: staffId,
          pdfPageCount,
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
            classification: checked.classification,
            clientId: clientId ?? null,
            sha256: commit.sha256.toString('hex'),
            immutable: commit.immutable,
          },
          ip: getClientIp(req.headers),
          userAgent: req.headers.get('user-agent'),
        });
        return { documentId: document.id, classification: checked.classification };
      },
    });
  } catch (e) {
    return uploadErrorResponse(e, tenantId);
  }

  // 6. n8n-Event (fire-and-forget)
  const { result, commit } = stored;
  await emitN8nEvent(
    'document.uploaded',
    {
      tenantId,
      documentId: result.documentId,
      classification: result.classification,
      clientId: clientId ?? null,
      isGobd: isGobdClassification(result.classification),
    },
    { tenantId },
  );

  return NextResponse.json({
    ok: true,
    documentId: result.documentId,
    sha256: commit.sha256.toString('hex'),
    immutable: commit.immutable,
  });
}

function uploadErrorResponse(error: unknown, tenantId: string): NextResponse {
  if (!(error instanceof JournaledUploadError)) {
    log.error(
      { component: 'documents-commit', tenantId, err: (error as Error)?.message ?? null },
      'documents-commit: unerwarteter Upload-Fehler',
    );
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
  switch (error.phase) {
    case 'check':
      return preflightErrorResponse(error.cause, tenantId);
    case 'prepare':
    case 'store':
      // Befund 12: Mapping zentral (war 3× wortgleich kopiert).
      return storageCommitErrorResponse(error.cause);
    case 'journal':
      log.error(
        { component: 'documents-commit', tenantId, err: error.message },
        'documents-commit: Speicherabsicht konnte nicht journalisiert werden',
      );
      return NextResponse.json({ error: 'internal_error' }, { status: 500 });
    case 'commit':
      // Die Speicherabsicht bleibt offen; der Cleanup-Worker räumt das Objekt
      // nach der Sicherheitsfrist versionsgenau auf.
      if (isReferenceChange(error.cause)) {
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
}

/** In der Commit-Transaktion bedeutet jeder Prüfungsfehler: Referenz geändert. */
function isReferenceChange(error: unknown): boolean {
  return (
    error instanceof ReferenceChangedError ||
    error instanceof ReminderUploadError ||
    error instanceof UploadValidationError
  );
}

/** Nur bekannte Validierungsfehler dürfen vor dem Store-Write ins UI gelangen. */
function preflightErrorResponse(error: unknown, tenantId: string): NextResponse {
  if (error instanceof ReminderUploadError || error instanceof UploadValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  log.error(
    { component: 'documents-commit', tenantId, err: error instanceof Error ? error.message : '' },
    'documents-commit: Validierungs-Tx vor Storage-Commit fehlgeschlagen',
  );
  return NextResponse.json({ error: 'internal_error' }, { status: 500 });
}
