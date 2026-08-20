// =============================================================================
// Idempotente ACP-Provisionierung für die von TaxTronik betriebene n8n-Instanz.
//
// Der Deploy ruft diesen Schritt nach der Tenant-Provisionierung bei JEDEM Lauf
// auf. Bestehende manuelle oder Legacy-Konfigurationen werden niemals
// überschrieben; lediglich die früher automatisch provisionierten internen
// Compose-Adressen einschließlich daraus erkannter verwalteter Routen werden
// auf die bekannte öffentliche Domain migriert. Der n8n-Public-API-Key bleibt
// bewusst leer: n8n gibt ihn erst nach Anmeldung des Instanz-Owners aus; er
// wird anschließend im ACP hinterlegt.
// =============================================================================

import { PrismaClient } from '../src/prisma-client';
import { createPostgresAdapter, requireDatabaseUrl } from '../src/prisma-adapter';
import {
  buildManagedN8nEndpointRepair,
  buildManagedN8nProvisionPlan,
  buildManagedN8nProvisionRepair,
} from './n8n-provision-plan';

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
    select: { id: true, kind: true, apiBaseUrl: true, webhookBaseUrl: true },
  });
  if (existing) {
    const repair = buildManagedN8nProvisionRepair(plan, existing);
    const endpoints =
      existing.kind === 'BUNDLED'
        ? await prisma.n8nWebhookEndpoint.findMany({
            where: { tenantId: tenant.id, connectionId: existing.id },
            select: { id: true, source: true, productionUrl: true, testUrl: true },
          })
        : [];
    const endpointRepairs = endpoints.flatMap((endpoint) => {
      const data = buildManagedN8nEndpointRepair(plan, endpoint);
      return data ? [{ id: endpoint.id, data }] : [];
    });
    if (repair || endpointRepairs.length > 0) {
      await prisma.$transaction(async (tx) => {
        if (repair) await tx.n8nConnection.update({ where: { id: existing.id }, data: repair });
        for (const endpoint of endpointRepairs) {
          await tx.n8nWebhookEndpoint.update({ where: { id: endpoint.id }, data: endpoint.data });
        }
      });
      console.log(
        `[provision-n8n] Veraltete interne ACP-Adressen auf die öffentliche n8n-Domain umgestellt (${endpointRepairs.length} Workflow-Route(n)).`,
      );
      return;
    }
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
