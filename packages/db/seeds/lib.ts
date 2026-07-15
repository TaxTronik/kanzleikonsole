// =============================================================================
// Gemeinsame Bausteine für Dev-Seed (dev.ts) und Production-Provisionierung
// (provision.ts) — strukturelle Grundausstattung, KEINE Demodaten.
// =============================================================================

import type { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function generateAdminPassword(): string {
  // base64url, 18 Bytes = 24 Zeichen, ~144 Bit Entropie. Memorierbar genug
  // für einmaligen Login + TOTP-Setup, danach kann der Admin selbst rotieren.
  return randomBytes(18)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function adminCredentialsPath(): string {
  const explicitPath = process.env['ADMIN_CREDENTIALS_PATH']?.trim();
  if (explicitPath) return resolve(explicitPath);

  return resolve(process.env['INIT_CWD'] || process.cwd(), '.admin-credentials.txt');
}

export function writeAdminCredentials(email: string, password: string): string {
  const credPath = adminCredentialsPath();
  writeFileSync(credPath, `email=${email}\npassword=${password}\n`, { mode: 0o600 });
  return credPath;
}

/**
 * Vollständiger Rechtsträger-Snapshot des ausschließlich lokalen
 * Dev-Mandanten. Die Werte sind Demodaten; sie dürfen nie für die
 * Production-Provisionierung verwendet werden.
 */
export const DEV_SEED_GWG_LEGAL_ENTITY_SNAPSHOT = {
  legalForm: 'GmbH',
  registerNumber: 'HRB 10001',
  registerAuthority: 'Amtsgericht Musterstadt',
  noRegisterEntry: false,
  representativeNames: ['Max Mustermann'],
  ownershipStructureNotes:
    'Max Mustermann hält sämtliche Geschäftsanteile und übt die Kontrolle unmittelbar aus.',
};

type GwgLegalEntitySnapshot = {
  legalForm: string | null;
  registerNumber: string | null;
  registerAuthority: string | null;
  noRegisterEntry: boolean;
  representativeNames: string[];
  ownershipStructureNotes: string | null;
};

export function hasCompleteGwgLegalEntitySnapshot(snapshot: GwgLegalEntitySnapshot): boolean {
  return Boolean(
    snapshot.legalForm?.trim() &&
    snapshot.representativeNames.some((name) => name.trim().length > 0) &&
    snapshot.ownershipStructureNotes?.trim() &&
    (snapshot.noRegisterEntry ||
      (snapshot.registerNumber?.trim() && snapshot.registerAuthority?.trim())),
  );
}

/**
 * Stellt den für E2E benötigten GwG-Check idempotent her.
 *
 * Frühere Seed-Versionen konnten nach der Fail-closed-Härtung einen formal
 * VERIFIED, aber unvollständigen Rechtsträger-Snapshot hinterlassen. Ein
 * solcher Check darf weder wiederverwendet noch nachträglich ergänzt werden,
 * weil verifizierte Snapshots unveränderlich sind. Er wird deshalb korrekt auf
 * EXPIRED gesetzt und durch einen neuen vollständigen Demodatensatz ersetzt.
 */
export async function ensureDevSeedVerifiedGwgCheck(
  prisma: PrismaClient,
  input: { tenantId: string; clientId: string; verifiedBy: string; now?: Date },
): Promise<{ id: string }> {
  const now = input.now ?? new Date();
  const candidates = await prisma.gwgCheck.findMany({
    where: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      status: 'VERIFIED',
      destroyedAt: null,
    },
    select: {
      id: true,
      validUntil: true,
      verifiedAt: true,
      verifiedBy: true,
      legalForm: true,
      registerNumber: true,
      registerAuthority: true,
      noRegisterEntry: true,
      representativeNames: true,
      ownershipStructureNotes: true,
      identityAssignmentRequired: true,
    },
  });

  const hasReusableSnapshot = (check: (typeof candidates)[number]) =>
    check.verifiedAt !== null &&
    check.verifiedBy !== null &&
    (check.validUntil === null || check.validUntil > now) &&
    hasCompleteGwgLegalEntitySnapshot(check);

  let reusable: (typeof candidates)[number] | undefined;
  for (const check of candidates) {
    if (!hasReusableSnapshot(check)) continue;

    // Legacy checks are reusable only through the explicit migration
    // grandfathering flag. Post-cutover checks must still satisfy the exact
    // DB gate at the time the seed runs (including evidence and expiry).
    if (!check.identityAssignmentRequired) {
      reusable = check;
      break;
    }
    const [identity] = await prisma.$queryRawUnsafe<Array<{ has_identity: boolean }>>(
      'SELECT app.gwg_check_has_confirmed_identity($1::uuid) AS has_identity',
      check.id,
    );
    if (identity?.has_identity) {
      reusable = check;
      break;
    }
  }

  const staleIds = candidates.filter((check) => check.id !== reusable?.id).map((check) => check.id);
  if (staleIds.length > 0) {
    await prisma.gwgCheck.updateMany({
      where: { id: { in: staleIds }, status: 'VERIFIED' },
      data: { status: 'EXPIRED' },
    });
  }
  if (reusable) return { id: reusable.id };

  return prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      "SELECT set_config('app.current_tenant_id', $1, true)",
      input.tenantId,
    );
    await tx.$queryRawUnsafe("SELECT set_config('app.current_actor_type', 'STAFF', true)");
    await tx.$queryRawUnsafe(
      "SELECT set_config('app.current_actor_id', $1, true)",
      input.verifiedBy,
    );
    const check = await tx.gwgCheck.create({
      data: {
        tenantId: input.tenantId,
        clientId: input.clientId,
        status: 'DRAFT',
        validUntil: null,
        ...DEV_SEED_GWG_LEGAL_ENTITY_SNAPSHOT,
      },
      select: { id: true },
    });
    const representative = await tx.gwgRepresentative.create({
      data: {
        gwgCheckId: check.id,
        fullName: DEV_SEED_GWG_LEGAL_ENTITY_SNAPSHOT.representativeNames[0]!,
        position: 0,
      },
      select: { id: true, fullName: true },
    });
    const evidence = await tx.document.create({
      data: {
        tenantId: input.tenantId,
        clientId: input.clientId,
        title: 'Dev-Seed Identitätsnachweis Max Mustermann',
        classification: 'GWG_EVIDENCE',
        mimeType: 'image/jpeg',
      },
      select: { id: true },
    });
    await tx.documentVersion.create({
      data: {
        documentId: evidence.id,
        versionNo: 1,
        storageBucket: 'dev-seed',
        storageKey: `dev-seed/${evidence.id}/v1`,
        sha256: Buffer.alloc(32, 0x6d),
        sizeBytes: 1n,
        immutable: false,
        scanStatus: 'CLEAN',
        scanCompletedAt: now,
        createdById: input.verifiedBy,
      },
    });
    await tx.gwgIdDocument.create({
      data: {
        gwgCheckId: check.id,
        type: 'PERSONALAUSWEIS',
        ownerName: representative.fullName,
        documentId: evidence.id,
        representativeSubjectId: representative.id,
        identityAssignmentConfirmedAt: now,
        identityAssignmentConfirmedBy: input.verifiedBy,
        number: `DEV-SEED-${check.id}`,
        issuedBy: 'Bürgeramt Musterstadt',
        issueDate: new Date('2024-01-01T00:00:00.000Z'),
        expiryDate: new Date('2099-12-31T00:00:00.000Z'),
        verifiedAt: now,
      },
    });
    return tx.gwgCheck.update({
      where: { id: check.id },
      data: {
        status: 'VERIFIED',
        verifiedAt: now,
        verifiedBy: input.verifiedBy,
      },
      select: { id: true },
    });
  });
}

/**
 * Stellt sicher, dass die 7 Default-Dokumenttypen für einen Tenant existieren.
 * Idempotent — ergänzt nur fehlende Einträge, fasst vorhandene nicht an
 * (auch wenn der Anwender Name/Sort manuell überschrieben hat).
 */
export async function ensureDefaultDocumentTypes(
  prisma: PrismaClient,
  tenantId: string,
): Promise<void> {
  const defaults: Array<{
    name: string;
    tier: 'NONE' | 'GWG' | 'GOBD';
    retentionYears: number | null;
    classificationKey: string;
    sortOrder: number;
  }> = [
    {
      name: 'GoBD Rechnung',
      tier: 'GOBD',
      retentionYears: 8,
      classificationKey: 'GOBD_INVOICE',
      sortOrder: 10,
    },
    {
      name: 'Vertrag / Geschäftsbrief',
      tier: 'GOBD',
      retentionYears: 6,
      classificationKey: 'GOBD_CONTRACT',
      sortOrder: 20,
    },
    {
      name: 'GoBD Steuer',
      tier: 'GOBD',
      retentionYears: 10,
      classificationKey: 'GOBD_TAX',
      sortOrder: 30,
    },
    {
      name: 'GwG Nachweis',
      tier: 'GWG',
      retentionYears: 5,
      classificationKey: 'GWG_EVIDENCE',
      sortOrder: 40,
    },
    {
      name: 'Personal',
      tier: 'NONE',
      retentionYears: null,
      classificationKey: 'PERSONNEL',
      sortOrder: 50,
    },
    {
      name: 'Intern',
      tier: 'NONE',
      retentionYears: null,
      classificationKey: 'STAFF_PRIVATE',
      sortOrder: 60,
    },
    {
      name: 'Allgemein',
      tier: 'NONE',
      retentionYears: null,
      classificationKey: 'GENERAL',
      sortOrder: 70,
    },
  ];
  const existing = await prisma.documentType.findMany({
    where: { tenantId },
    select: { classificationKey: true },
  });
  const have = new Set(existing.map((d) => d.classificationKey));
  const missing = defaults.filter((d) => !have.has(d.classificationKey));
  if (missing.length === 0) {
    console.log('[seed] Dokumenttypen: bereits vorhanden.');
    return;
  }
  await prisma.documentType.createMany({
    data: missing.map((d) => ({
      tenantId,
      name: d.name,
      tier: d.tier,
      retentionYears: d.retentionYears,
      builtin: true,
      classificationKey: d.classificationKey,
      sortOrder: d.sortOrder,
    })),
  });
  console.log(`[seed] Dokumenttypen: ${missing.length} ergänzt.`);
}
