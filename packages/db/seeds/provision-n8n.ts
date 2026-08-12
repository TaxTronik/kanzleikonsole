// =============================================================================
// Idempotente ACP-Provisionierung für die von TaxTronik betriebene n8n-Instanz.
//
// Der Deploy ruft diesen Schritt nach der Tenant-Provisionierung bei JEDEM Lauf
// auf. Bestehende normalisierte oder Legacy-Konfigurationen werden niemals
// überschrieben. Der n8n-Public-API-Key bleibt bewusst leer: n8n gibt ihn erst
// nach Anmeldung des Instanz-Owners aus; er wird anschließend im ACP hinterlegt.
// =============================================================================

import { PrismaClient } from '../src/prisma-client';
import { createPostgresAdapter, requireDatabaseUrl } from '../src/prisma-adapter';
import { buildManagedN8nProvisionPlan } from './n8n-provision-plan';

const prisma = new PrismaClient({
  adapter: createPostgresAdapter(requireDatabaseUrl(process.env['DATABASE_URL'], 'DATABASE_URL')),
});

function fail(message: string): never {
  console.error(`[provision-n8n] FATAL: ${message}`);
  process.exit(1);
}

async function main() {
  const plan = buildManagedN8nProvisionPlan(process.env);
  if (!plan) {
    console.log('[provision-n8n] N8N_HOST ist leer — keine verwaltete ACP-Verbindung angelegt.');
    return;
  }

  const tenant = await prisma.tenant.findUnique({
    where: { slug: plan.tenantSlug },
    select: { id: true },
  });
  if (!tenant) {
    fail(`Tenant '${plan.tenantSlug}' wurde nicht gefunden.`);
  }

  const existing = await prisma.n8nConnection.findUnique({
    where: { tenantId: tenant.id },
    select: { id: true },
  });
  if (existing) {
    console.log('[provision-n8n] ACP-Verbindung ist bereits vorhanden — unverändert beibehalten.');
    return;
  }

  const legacy = await prisma.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId: tenant.id, key: 'integrations.n8n' } },
    select: { key: true },
  });
  if (legacy) {
    console.log('[provision-n8n] Legacy-Konfiguration ist vorhanden — unverändert beibehalten.');
    return;
  }

  await prisma.n8nConnection.create({
    data: {
      tenantId: tenant.id,
      name: 'TaxTronik n8n (verwaltet)',
      kind: 'BUNDLED',
      routingMode: 'DISABLED',
      enabled: false,
      uiBaseUrl: plan.uiBaseUrl,
      apiBaseUrl: plan.apiBaseUrl,
      webhookBaseUrl: plan.webhookBaseUrl,
      callbackBaseUrl: plan.callbackBaseUrl,
    },
  });
  console.log(
    '[provision-n8n] Verwaltete ACP-Verbindung angelegt; Routing bleibt bis zur Workflow-Einrichtung deaktiviert.',
  );
}

main()
  .catch((error) => fail(error instanceof Error ? error.message : String(error)))
  .finally(() => prisma.$disconnect());
