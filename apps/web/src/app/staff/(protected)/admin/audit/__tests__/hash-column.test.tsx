import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AuditLog } from '@prisma/client';
import { AuditEntries } from '../audit-entries';
import { parseAuditPageQuery } from '../audit-page-state';

describe('AUDIT-HASH-CHAIN-001: audit hash column', () => {
  it('renders the complete audit hash, including the trailing bytes, in a wrappable cell', () => {
    const hash = '0123456789abcdef'.repeat(4);
    const entry: AuditLog = {
      id: 1n,
      tenantId: 'tenant',
      occurredAt: new Date('2026-09-07T10:00:00Z'),
      actorType: 'SYSTEM',
      actorId: null,
      action: 'document.upload',
      resourceType: 'document',
      resourceId: null,
      before: null,
      after: null,
      ip: null,
      userAgent: null,
      prevHash: Buffer.alloc(32),
      thisHash: Buffer.from(hash, 'hex'),
    };
    const html = renderToStaticMarkup(
      <AuditEntries entries={[entry]} totalCount={1} filters={parseAuditPageQuery({})} />,
    );
    expect(html).toMatch(new RegExp(`<td class="[^"]*break-all[^"]*">${hash}</td>`));
  });
});
