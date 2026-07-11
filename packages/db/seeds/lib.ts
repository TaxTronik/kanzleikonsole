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
      name: 'GoBD Vertrag',
      tier: 'GOBD',
      retentionYears: 10,
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
