// =============================================================================
// kk-tcms-s11 Punkt 5: Dokumente aus dem Tax-CMS-Kontext (Nachweise, Anlagen
// einer Ereignismeldung) lösen `document.uploaded` über die echte n8n-Outbox
// aus – gegen PostgreSQL; nur die BullMQ-Queue ist ersetzt. Geprüft: Ereignis
// in der Whitelist, Nutzlast genau die Schlüssel der Upload-Routen plus
// Quelle (kein Titel, keine Daten des Tax-CMS), ein Ereignis je Dokument
// (Dedupe-Schlüssel), Tenant der Ablage.
//
//   DB_TESTS=1 (db_suite_env) pnpm exec vitest run --config vitest.db.config.ts \
//     src/server/tcms/__tests__/hochgeladen-db.test.ts
// Fachkatalog: TCMS-NACHWEIS-001
// =============================================================================
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ add: vi.fn(async () => ({ id: 'job' })) }));

vi.mock('server-only', () => ({}));
vi.mock('@/server/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/server/n8n/queue', () => ({ getN8nDeliverQueue: () => ({ add: h.add }) }));

import type { PrismaClient } from '@taxtronik/db';

const enabled = process.env.TCMS_BEREICH_D_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'TCMS_BEREICH_D_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}

(enabled ? describe : describe.skip)('document.uploaded aus dem Tax-CMS-Kontext', () => {
  let owner!: PrismaClient;
  let tenantId = '';
  const mandantId = randomUUID();

  beforeAll(async () => {
    ({ prismaOwner: owner } = await import('@taxtronik/db'));
    tenantId = (
      await owner.tenant.create({
        data: { slug: `tcms-s11-n8n-${randomUUID()}`, name: 'S11 n8n' },
      })
    ).id;
  });

  afterAll(async () => {
    await owner.n8nOutbox.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await owner.$disconnect();
  });

  it.each(['tcms-nachweis', 'tcms-meldung'] as const)(
    'Quelle %s: ein Ereignis je Dokument, Nutzlast ohne Inhalte',
    async (quelle) => {
      const { tcmsDokumentHochgeladen } = await import('../hochgeladen');
      const dokumentId = randomUUID();
      const eingabe = { tenantId, mandantId, dokumentId, classification: 'GENERAL', quelle };
      await tcmsDokumentHochgeladen(eingabe);
      // Wiederholung (z. B. nach einem Neustart): kein zweites Ereignis.
      await tcmsDokumentHochgeladen(eingabe);
      const zeilen = await owner.n8nOutbox.findMany({
        where: { tenantId, dedupeKey: `document.uploaded:${dokumentId}` },
      });
      expect(zeilen).toHaveLength(1);
      expect(zeilen[0]).toMatchObject({ event: 'document.uploaded', tenantId });
      expect(zeilen[0]!.payload).toEqual({
        tenantId,
        documentId: dokumentId,
        classification: 'GENERAL',
        clientId: mandantId,
        isGobd: false,
        source: quelle,
      });
    },
  );
});
