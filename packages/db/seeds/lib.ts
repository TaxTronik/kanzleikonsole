// =============================================================================
// Gemeinsame Bausteine für Dev-Seed (dev.ts) und Production-Provisionierung
// (provision.ts) — strukturelle Grundausstattung, KEINE Demodaten.
// =============================================================================

import type { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';

export function generateAdminPassword(): string {
  // base64url, 18 Bytes = 24 Zeichen, ~144 Bit Entropie. Memorierbar genug
  // für einmaligen Login + TOTP-Setup, danach kann der Admin selbst rotieren.
  return randomBytes(18)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
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
    classificationKey: string;
    sortOrder: number;
  }> = [
    { name: 'GoBD Rechnung', tier: 'GOBD', classificationKey: 'GOBD_INVOICE', sortOrder: 10 },
    { name: 'GoBD Vertrag',  tier: 'GOBD', classificationKey: 'GOBD_CONTRACT', sortOrder: 20 },
    { name: 'GoBD Steuer',   tier: 'GOBD', classificationKey: 'GOBD_TAX',      sortOrder: 30 },
    { name: 'GwG Nachweis',  tier: 'GWG',  classificationKey: 'GWG_EVIDENCE',  sortOrder: 40 },
    { name: 'Personal',      tier: 'NONE', classificationKey: 'PERSONNEL',     sortOrder: 50 },
    { name: 'Intern',        tier: 'NONE', classificationKey: 'STAFF_PRIVATE', sortOrder: 60 },
    { name: 'Allgemein',     tier: 'NONE', classificationKey: 'GENERAL',       sortOrder: 70 },
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
      builtin: true,
      classificationKey: d.classificationKey,
      sortOrder: d.sortOrder,
    })),
  });
  console.log(`[seed] Dokumenttypen: ${missing.length} ergänzt.`);
}
