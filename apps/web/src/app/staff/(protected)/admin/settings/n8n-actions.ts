'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import {
  readN8nConfig,
  writeN8nConfig,
  deleteN8nConfig,
  type N8nConfig,
} from '@/server/settings/n8n';
import { pingN8nWebhook } from '@/server/n8n/emit';
import { N8nApiClient } from '@/server/n8n/client';
import { assertPublicHost } from '@/server/http/ssrf-guard';

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

const N8nSchema = z.object({
  webhookBaseUrl: z.string().max(255).optional().or(z.literal('')),
  hmacSecret: z.string().max(500).optional().or(z.literal('')),
  apiBaseUrl: z.string().max(255).optional().or(z.literal('')),
  apiKey: z.string().max(500).optional().or(z.literal('')),
  keepHmac: z.boolean().default(false),
  keepApiKey: z.boolean().default(false),
});

function parseN8nForm(formData: FormData) {
  return N8nSchema.safeParse({
    webhookBaseUrl: formData.get('webhookBaseUrl') ?? '',
    hmacSecret: formData.get('hmacSecret') ?? '',
    apiBaseUrl: formData.get('apiBaseUrl') ?? '',
    apiKey: formData.get('apiKey') ?? '',
    keepHmac: formData.get('keepHmac') === 'on',
    keepApiKey: formData.get('keepApiKey') === 'on',
  });
}

async function requireAdmin() {
  const session = await staffAuth();
  if (!session?.user) return { ok: false as const, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) {
    return { ok: false as const, error: 'Nur ADMIN/PARTNER.' };
  }
  return { ok: true as const, tenantId: session.user.tenantId, staffId: session.user.staffId };
}

export async function saveN8nAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsed = parseN8nForm(formData);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const ctx = { tenantId: auth.tenantId, actorId: auth.staffId, actorType: 'STAFF' as const };

  // Bei "keep…" das bestehende Secret aus DB nehmen, sonst Form-Wert
  let hmac = parsed.data.hmacSecret ?? '';
  let apiKey = parsed.data.apiKey ?? '';
  if (parsed.data.keepHmac || parsed.data.keepApiKey) {
    const existing = await readN8nConfig(ctx);
    if (parsed.data.keepHmac) hmac = existing?.hmacSecret ?? '';
    if (parsed.data.keepApiKey) apiKey = existing?.apiKey ?? '';
  }

  const cfg: N8nConfig = {
    webhookBaseUrl: (parsed.data.webhookBaseUrl ?? '').trim(),
    hmacSecret: hmac,
    apiBaseUrl: (parsed.data.apiBaseUrl ?? '').trim(),
    apiKey,
  };

  // NEW1: SSRF-Schutz beim Speichern — sonst kann ein Admin eine interne URL
  // persistieren, die der Worker (n8n-deliver) später jedes Mal anfragt.
  try {
    if (cfg.webhookBaseUrl) await assertPublicHost(cfg.webhookBaseUrl);
    if (cfg.apiBaseUrl) await assertPublicHost(cfg.apiBaseUrl);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  await writeN8nConfig(ctx, cfg);

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'tenant.settings.n8n.update',
      resourceType: 'tenant_setting',
      resourceId: 'integrations.n8n',
      after: {
        webhookBaseUrl: cfg.webhookBaseUrl || null,
        apiBaseUrl: cfg.apiBaseUrl || null,
        hmacSecret: cfg.hmacSecret ? '***' : null,
        apiKey: cfg.apiKey ? '***' : null,
      },
    });
  });

  revalidatePath('/staff/admin/settings/n8n');
  revalidatePath('/staff/admin/settings/integrations');
  return { ok: true };
}

export async function resetN8nAction(): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const ctx = { tenantId: auth.tenantId, actorId: auth.staffId, actorType: 'STAFF' as const };
  await deleteN8nConfig(ctx);
  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'tenant.settings.n8n.reset',
      resourceType: 'tenant_setting',
      resourceId: 'integrations.n8n',
      after: null,
    });
  });
  revalidatePath('/staff/admin/settings/n8n');
  return { ok: true };
}

export async function testN8nPingAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsed = parseN8nForm(formData);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const ctx = { tenantId: auth.tenantId, actorId: auth.staffId, actorType: 'STAFF' as const };
  let hmac = parsed.data.hmacSecret ?? '';
  if (parsed.data.keepHmac) {
    hmac = (await readN8nConfig(ctx))?.hmacSecret ?? '';
  }

  const webhookUrl = (parsed.data.webhookBaseUrl ?? '').trim();
  // NEW1: SSRF-Schutz — Admin-supplied URL nicht ungeprüft fetchen.
  try {
    if (webhookUrl) await assertPublicHost(webhookUrl);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  try {
    const r = await pingN8nWebhook(webhookUrl, hmac);
    if (r.ok) {
      return { ok: true, message: `OK (${r.latencyMs} ms, HTTP ${r.status})` };
    }
    return {
      ok: false,
      error: `HTTP ${r.status} — ${r.body || '(leere Antwort)'}`,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function testN8nApiAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const parsed = parseN8nForm(formData);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const ctx = { tenantId: auth.tenantId, actorId: auth.staffId, actorType: 'STAFF' as const };
  let apiKey = parsed.data.apiKey ?? '';
  if (parsed.data.keepApiKey) {
    apiKey = (await readN8nConfig(ctx))?.apiKey ?? '';
  }

  const apiUrl = (parsed.data.apiBaseUrl ?? '').trim();
  // NEW1: SSRF-Schutz.
  try {
    if (apiUrl) await assertPublicHost(apiUrl);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  try {
    const client = new N8nApiClient(apiUrl, apiKey);
    const r = await client.ping();
    return {
      ok: true,
      message: `OK (${r.latencyMs} ms, ${r.workflowCount} Workflows sichtbar)`,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Importiert alle mitgelieferten Workflow-JSONs aus `infra/n8n/workflows/`
 * in die n8n-Instanz. Skippt Workflows, deren Name bereits existiert
 * (idempotent — kann mehrfach aufgerufen werden).
 */
export async function importWorkflowsAction(): Promise<ActionResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const ctx = { tenantId: auth.tenantId, actorId: auth.staffId, actorType: 'STAFF' as const };
  const cfg = await readN8nConfig(ctx);
  if (!cfg?.apiBaseUrl || !cfg?.apiKey) {
    return { ok: false, error: 'n8n-API ist nicht konfiguriert.' };
  }

  const workflowsDir = join(process.cwd(), '..', '..', 'infra', 'n8n', 'workflows');
  let files: string[];
  try {
    files = (await readdir(workflowsDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return { ok: false, error: `Workflow-Verzeichnis nicht gefunden: ${workflowsDir}` };
  }
  if (files.length === 0) {
    return { ok: false, error: `Keine Workflow-JSONs in ${workflowsDir}.` };
  }

  // F1: TOCTOU-Schutz — DB-gespeicherte URL bei jedem Use re-validieren.
  try {
    await assertPublicHost(cfg.apiBaseUrl);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const client = new N8nApiClient(cfg.apiBaseUrl, cfg.apiKey);
  const existing = await client.listWorkflows();
  const existingNames = new Set(existing.map((w) => w.name));

  const imported: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const file of files.sort()) {
    try {
      const raw = await readFile(join(workflowsDir, file), 'utf-8');
      const wf = JSON.parse(raw) as Record<string, unknown>;
      const name = typeof wf['name'] === 'string' ? wf['name'] : file;
      if (existingNames.has(name)) {
        skipped.push(name);
        continue;
      }
      const created = await client.createWorkflow(wf);
      try { await client.activateWorkflow(created.id); } catch { /* Aktivieren ist optional */ }
      imported.push(name);
    } catch (e) {
      errors.push(`${file}: ${(e as Error).message}`);
    }
  }

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'tenant.settings.n8n.workflows_import',
      resourceType: 'tenant_setting',
      resourceId: 'integrations.n8n',
      after: { imported, skipped, errors },
    });
  });

  const parts: string[] = [];
  if (imported.length) parts.push(`Importiert: ${imported.length}`);
  if (skipped.length) parts.push(`bereits vorhanden: ${skipped.length}`);
  if (errors.length) parts.push(`Fehler: ${errors.length}`);
  return {
    ok: errors.length === 0,
    message: parts.join(' · ') || 'Nichts zu tun.',
    error: errors.length ? errors.join('\n') : undefined,
  };
}

export async function listWorkflowsAction(): Promise<{
  ok: boolean;
  error?: string;
  workflows?: { id: string; name: string; active: boolean; updatedAt: string }[];
}> {
  const auth = await requireAdmin();
  if (!auth.ok) return { ok: false, error: auth.error };
  const ctx = { tenantId: auth.tenantId, actorId: auth.staffId, actorType: 'STAFF' as const };
  const cfg = await readN8nConfig(ctx);
  if (!cfg?.apiBaseUrl || !cfg?.apiKey) {
    return { ok: false, error: 'n8n-API ist nicht konfiguriert.' };
  }
  // F1: TOCTOU-Schutz.
  try {
    await assertPublicHost(cfg.apiBaseUrl);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  try {
    const client = new N8nApiClient(cfg.apiBaseUrl, cfg.apiKey);
    const wfs = await client.listWorkflows();
    return {
      ok: true,
      workflows: wfs.map((w) => ({
        id: w.id,
        name: w.name,
        active: w.active,
        updatedAt: w.updatedAt,
      })),
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
