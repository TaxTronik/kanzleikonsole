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
//   3. Workflows aktivieren
//
// Alle Requests timeouten nach 10 s, damit eine kaputte n8n-Instanz die UI
// nicht aufhält.
// =============================================================================

const TIMEOUT_MS = 10_000;

export interface N8nWorkflowSummary {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  tags?: { id: string; name: string }[];
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
      const res = await fetch(this.url(path), {
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
    const data = await this.request<{ data: N8nWorkflowSummary[] }>('GET', '/workflows');
    return data.data ?? [];
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

  async activateWorkflow(id: string): Promise<void> {
    await this.request<unknown>('POST', `/workflows/${encodeURIComponent(id)}/activate`);
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
function sanitizeWorkflowForImport(workflow: Record<string, unknown>): Record<string, unknown> {
  const allowed = ['name', 'nodes', 'connections', 'settings', 'staticData'];
  const out: Record<string, unknown> = {};
  for (const k of allowed) {
    if (k in workflow) out[k] = workflow[k];
  }
  if (!out['settings']) out['settings'] = {};
  return out;
}
