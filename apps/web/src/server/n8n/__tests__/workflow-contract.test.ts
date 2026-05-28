import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('n8n workflow contract', () => {
  it('request.opened workflow verifies the outbound HMAC contract and passes tenantId', () => {
    const workflowPath = join(
      process.cwd(),
      '..',
      '..',
      'infra',
      'n8n',
      'workflows',
      '03-request-opened.json',
    );
    const workflow = JSON.parse(readFileSync(workflowPath, 'utf8')) as {
      nodes: Array<{ id: string; parameters?: Record<string, unknown> }>;
    };

    const hmacNode = workflow.nodes.find((node) => node.id === 'verify-hmac');
    const fetchNode = workflow.nodes.find((node) => node.id === 'fetch-detail');
    const jsCode = String(hmacNode?.parameters?.['jsCode'] ?? '');
    const url = String(fetchNode?.parameters?.['url'] ?? '');

    expect(jsCode).toContain("headers['x-taxtronik-event']");
    expect(jsCode).toContain("headers['x-taxtronik-timestamp']");
    expect(jsCode).toContain("headers['x-taxtronik-nonce']");
    expect(jsCode).toContain('`${event}\\n${ts}\\n${nonce}\\n${body}`');
    expect(url).toContain('request-detail/');
    expect(url).toContain('tenantId=');
    expect(url).toContain('$json.body.tenantId || $json.body.payload.tenantId');
  });
});
