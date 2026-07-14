// =============================================================================
// n8n-REST-API-Client (Public API v1)
//
// Doku: https://docs.n8n.io/api/api-reference/
// Auth: `X-N8N-API-KEY: <key>` Header — Key wird in der n8n-UI unter
//       Settings → API → Create new API key erzeugt.
//
// Wir nutzen die Public API für drei Zwecke:
//   1. Workflows auflisten (Diagnose: was läuft, was nicht?)
//   2. Workflows importieren (Onboarding-Komfort)
//   3. Webhook-Knoten entdecken (die Aktivierung bleibt bewusst in n8n)
//
// Alle Requests timeouten nach 10 s, damit eine kaputte n8n-Instanz die UI
// nicht aufhält.
// =============================================================================

import { safeFetch } from '@taxtronik/http-utils';

const TIMEOUT_MS = 10_000;

export interface N8nWorkflowSummary {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  tags?: { id: string; name: string }[];
}

export interface N8nWorkflowNode {
  id?: string;
  name: string;
  type: string;
  disabled?: boolean;
  parameters?: {
    path?: unknown;
    httpMethod?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface N8nWorkflow extends N8nWorkflowSummary {
  nodes: N8nWorkflowNode[];
  connections?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

export interface N8nDiscoveredWebhook {
  workflowId: string;
  workflowName: string;
  workflowActive: boolean;
  nodeId: string;
  nodeName: string;
  path: string;
  httpMethod: string;
}

export class N8nApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {
    if (!baseUrl) throw new Error('n8n-API-URL fehlt');
    if (!apiKey) throw new Error('n8n-API-Key fehlt');
  }

  private url(path: string): string {
    const base = this.baseUrl.replace(/\/$/, '');
    return base + (path.startsWith('/') ? path : '/' + path);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      // `safeFetch` validiert DNS und pinnt die geprüfte IP. Das ist auch
      // nach dem Speichern nötig: ein DNS-Eintrag kann später auf eine
      // interne Adresse umgebogen werden (DNS rebinding).
      const res = await safeFetch(this.url(path), {
        method,
        headers: {
          'X-N8N-API-KEY': this.apiKey,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`n8n ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
      }
      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(to);
    }
  }

  async listWorkflows(): Promise<N8nWorkflowSummary[]> {
    const workflows: N8nWorkflowSummary[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    let pages = 0;

    // Die Public API ist cursor-paginiert. Ohne Pagination würde die
    // Einrichtung bei größeren Instanzen still nur einen Teil anzeigen.
    do {
      const query = new URLSearchParams({ limit: '250' });
      if (cursor) query.set('cursor', cursor);
      const data = await this.request<{
        data: N8nWorkflowSummary[];
        nextCursor?: string | null;
      }>('GET', `/workflows?${query.toString()}`);
      workflows.push(...(data.data ?? []));
      cursor = data.nextCursor ?? undefined;
      pages += 1;
      if (pages > 100) throw new Error('n8n-Workflow-Liste überschreitet das sichere Seitenlimit.');
      if (cursor && seenCursors.has(cursor)) {
        throw new Error('n8n-API lieferte einen wiederholten Pagination-Cursor.');
      }
      if (cursor) seenCursors.add(cursor);
    } while (cursor);

    return workflows;
  }

  async getWorkflow(id: string): Promise<N8nWorkflow> {
    return this.request<N8nWorkflow>('GET', `/workflows/${encodeURIComponent(id)}`);
  }

  /**
   * Liest alle Workflows und gibt ausschließlich echte, aktive Webhook-Nodes
   * zurück. Die daraus abgeleitete URL wird absichtlich nicht hier gebaut:
   * bei Reverse-Proxies kann die öffentliche WEBHOOK_URL von der API-URL
   * abweichen und muss in TaxTronik separat angegeben werden.
   */
  async discoverWebhooks(): Promise<N8nDiscoveredWebhook[]> {
    const summaries = await this.listWorkflows();
    const workflows: N8nWorkflow[] = [];
    // safeFetch pinnt pro Request einen eigenen Agent. Kleine Batches halten
    // Admin-Latenz niedrig, ohne bei großen Instanzen hunderte Verbindungen
    // gleichzeitig zu öffnen.
    for (let offset = 0; offset < summaries.length; offset += 5) {
      const batch = summaries.slice(offset, offset + 5);
      workflows.push(...(await Promise.all(batch.map((item) => this.getWorkflow(item.id)))));
    }

    return workflows.flatMap((workflow) =>
      (workflow.nodes ?? []).flatMap((node): N8nDiscoveredWebhook[] => {
        if (node.type !== 'n8n-nodes-base.webhook' || node.disabled) return [];
        const rawPath = node.parameters?.path;
        if (typeof rawPath !== 'string' || !rawPath.trim()) return [];
        const rawMethod = node.parameters?.httpMethod;
        return [
          {
            workflowId: workflow.id,
            workflowName: workflow.name,
            workflowActive: workflow.active,
            nodeId: node.id ?? '',
            nodeName: node.name,
            path: rawPath.replace(/^\/+|\/+$/g, ''),
            httpMethod: typeof rawMethod === 'string' ? rawMethod.toUpperCase() : 'GET',
          },
        ];
      }),
    );
  }

  /**
   * Importiert einen Workflow aus einer JSON-Definition (wie aus
   * n8n-Export — die Felder `id`, `versionId`, `createdAt`, `updatedAt`,
   * `tags` müssen vorher entfernt werden, sonst rejected die n8n-API
   * mit 400.
   */
  async createWorkflow(workflow: Record<string, unknown>): Promise<N8nWorkflowSummary> {
    const cleaned = sanitizeWorkflowForImport(workflow);
    return this.request<N8nWorkflowSummary>('POST', '/workflows', cleaned);
  }

  /**
   * Light-Touch-Ping: ruft `/workflows?limit=1` auf — sieht so eine
   * authentifizierte Verbindung und meldet Latenz. Wenn die API nicht
   * antwortet oder den Key ablehnt, wirft die Methode.
   */
  async ping(): Promise<{ latencyMs: number; workflowCount: number }> {
    const start = Date.now();
    const data = await this.request<{ data: unknown[] }>('GET', '/workflows?limit=1');
    return {
      latencyMs: Date.now() - start,
      workflowCount: Array.isArray(data.data) ? data.data.length : 0,
    };
  }
}

/**
 * Entfernt Felder aus einem n8n-Workflow-JSON, die beim POST /workflows zu
 * 400 führen würden (read-only oder unbekannte Felder). Konservativer Filter
 * — n8n akzeptiert nur eine Whitelist von Eigenschaften beim Erstellen.
 */
export function sanitizeWorkflowForImport(
  workflow: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = ['name', 'nodes', 'connections', 'settings', 'staticData'];
  const out: Record<string, unknown> = {};
  for (const k of allowed) {
    if (k in workflow) out[k] = workflow[k];
  }
  if (!out['settings']) out['settings'] = {};
  return out;
}
