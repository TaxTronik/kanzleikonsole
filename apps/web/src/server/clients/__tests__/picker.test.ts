// Fachkatalog: ACCESS-CLIENT-MODE-001, ACCESS-SEARCH-SCOPE-001
//
// Die Suche wird mit der echten `accessibleClientsWhereFor`-Regel und einem
// kleinen In-Memory-Auswerter für genau die erzeugten Prisma-Bedingungen
// geprüft. Der PostgreSQL-Nachweis mit App-Rolle und RLS liegt in
// server/auth/__tests__/invoice-selection-db.test.tsx.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffSession } from '@/server/auth/staff';
import type { TxClient } from '@taxtronik/db';

const fixture = vi.hoisted(() => ({ mode: 'OPEN' as 'OPEN' | 'RESTRICTED' }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: vi.fn() }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/server/settings/access-policy', () => ({
  readAccessPolicyTx: async () => ({ clientAccessMode: fixture.mode }),
}));

import {
  escapeLikePattern,
  hasClientPickerOptionTx,
  loadClientPickerOptionsTx,
  searchClientPickerTx,
} from '../picker';
import { CLIENT_PICKER_LIMIT } from '@/lib/client-picker';

interface Row {
  id: string;
  tenantId: string;
  name: string;
  datevNo: string | null;
  addisonNo: string | null;
  allowActive: boolean;
  mandateEndedAt: Date | null;
  anonymizedAt: Date | null;
  vertraulich: boolean;
  responsibilities: Array<{ staffId: string; role: string }>;
  workflowInstances: Array<{ status: string }>;
}

type Where = Record<string, unknown>;

function likeContains(value: string | null, pattern: string): boolean {
  if (value === null) return false;
  // Nur maskierte Metazeichen werden erzeugt; unmaskiert wären es Wildcards.
  if (/(^|[^\\])[%_]/.test(pattern)) throw new Error('unmaskiertes LIKE-Metazeichen: ' + pattern);
  return value.toLowerCase().includes(pattern.replace(/\\(.)/g, '$1').toLowerCase());
}

function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    const value = row[key];
    if (Array.isArray(value)) {
      const { some } = cond as { some: Where };
      return value.some((item) => matches(item as Record<string, unknown>, some));
    }
    if (cond === null || typeof cond !== 'object') return value === cond;
    const c = cond as { in?: unknown[]; contains?: string; mode?: string };
    if (c.in) return c.in.includes(value);
    if (c.contains !== undefined) return likeContains(value as string | null, c.contains);
    throw new Error('Nicht unterstützte Bedingung: ' + key);
  });
}

function compare(a: Row, b: Row, order: Array<Record<string, 'asc' | 'desc'>>): number {
  for (const entry of order) {
    const [key, dir] = Object.entries(entry)[0]!;
    const av = a[key as keyof Row] as string | boolean;
    const bv = b[key as keyof Row] as string | boolean;
    if (av === bv) continue;
    // Deutsche Sortierung wie die Datenbank-Kollation (Ö neben O).
    const result =
      typeof av === 'string' && typeof bv === 'string'
        ? av.localeCompare(bv, 'de')
        : av < bv
          ? -1
          : 1;
    return dir === 'asc' ? result : -result;
  }
  return 0;
}

function pick(row: Row, select: Record<string, boolean>) {
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key as keyof Row]]));
}

function fakeTx(rows: Row[]) {
  const findMany = vi.fn(
    async (args: {
      where: Where;
      orderBy?: Array<Record<string, 'asc' | 'desc'>>;
      take?: number;
      select: Record<string, boolean>;
    }) => {
      const found = rows.filter((row) =>
        matches(row as unknown as Record<string, unknown>, args.where),
      );
      const sorted = args.orderBy ? [...found].sort((a, b) => compare(a, b, args.orderBy!)) : found;
      return sorted.slice(0, args.take ?? sorted.length).map((row) => pick(row, args.select));
    },
  );
  const findFirst = vi.fn(async (args: { where: Where; select: Record<string, boolean> }) => {
    const row = rows.find((r) => matches(r as unknown as Record<string, unknown>, args.where));
    return row ? pick(row, args.select) : null;
  });
  return { tx: { client: { findMany, findFirst } } as unknown as TxClient, findMany, findFirst };
}

let seq = 0;
function client(name: string, patch: Partial<Row> = {}): Row {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    tenantId: 'tenant-a',
    name,
    datevNo: null,
    addisonNo: null,
    allowActive: true,
    mandateEndedAt: null,
    anonymizedAt: null,
    vertraulich: false,
    responsibilities: [],
    workflowInstances: [],
    ...patch,
  };
}

function session(roles: string[] = ['EMPLOYEE'], staffId = 'staff-a'): StaffSession {
  return {
    expires: '2099-01-01T00:00:00.000Z',
    user: {
      id: staffId,
      email: 'staff@example.test',
      name: 'Test',
      fullName: 'Test',
      tenantId: 'tenant-a',
      staffId,
      roles,
      permissions: [],
    },
  } as StaffSession;
}

const names = (result: { clients: Array<{ name: string }> }) => result.clients.map((c) => c.name);

beforeEach(() => {
  fixture.mode = 'OPEN';
});

describe('Mandantensuche der ClientCombobox — Zugriffsregel', () => {
  const assigned = { staffId: 'staff-a', role: 'HAUPTBEARBEITER' };
  const rows = () => [
    client('Muster Öffentlich GmbH'),
    client('Muster Vertraulich GmbH', { vertraulich: true }),
    client('Muster Vertraulich Zugeordnet', { vertraulich: true, responsibilities: [assigned] }),
    client('Muster Vertreter Vertraulich', {
      vertraulich: true,
      responsibilities: [{ staffId: 'staff-a', role: 'VERTRETER' }],
    }),
    client('Muster Fremder Tenant', { tenantId: 'tenant-b' }),
  ];

  it('findet einen vertraulichen Mandanten für nicht zugeordnete Mitarbeiter nicht (OPEN)', async () => {
    const { tx } = fakeTx(rows());
    const result = await searchClientPickerTx(tx, session(), { query: 'muster', filters: [] });
    expect(names(result)).toEqual(['Muster Öffentlich GmbH', 'Muster Vertraulich Zugeordnet']);
  });

  it('zeigt in RESTRICTED nur Berufsträger-/Hauptbearbeiter-Zuordnungen', async () => {
    fixture.mode = 'RESTRICTED';
    const { tx } = fakeTx(rows());
    const result = await searchClientPickerTx(tx, session(), { query: 'muster', filters: [] });
    expect(names(result)).toEqual(['Muster Vertraulich Zugeordnet']);
  });

  it('behält den Admin-/Partner-Override, aber nie fremde Tenants', async () => {
    const { tx } = fakeTx(rows());
    for (const role of ['ADMIN', 'PARTNER']) {
      const result = await searchClientPickerTx(tx, session([role]), {
        query: 'muster',
        filters: [],
      });
      expect(names(result)).toEqual([
        'Muster Öffentlich GmbH',
        'Muster Vertraulich GmbH',
        'Muster Vertraulich Zugeordnet',
        'Muster Vertreter Vertraulich',
      ]);
    }
  });

  it('liefert auch Vorauswahl-Namen nur für sichtbare Mandanten', async () => {
    const data = rows();
    const { tx } = fakeTx(data);
    const options = await loadClientPickerOptionsTx(tx, session(), [
      data[0]!.id,
      data[1]!.id,
      data[4]!.id,
      'keine-uuid',
      null,
    ]);
    expect([...options.values()].map((o) => o.name)).toEqual(['Muster Öffentlich GmbH']);
  });
});

describe('Mandantensuche der ClientCombobox — Begrenzung, Filter, Reihenfolge', () => {
  it('deckelt serverseitig und meldet weitere Treffer', async () => {
    const data = Array.from({ length: 25 }, (_, i) =>
      client(`Serie ${String(i).padStart(2, '0')}`),
    );
    const { tx, findMany } = fakeTx(data);
    const result = await searchClientPickerTx(tx, session(), { query: 'serie', filters: [] });
    expect(result.clients).toHaveLength(CLIENT_PICKER_LIMIT);
    expect(result.limited).toBe(true);
    expect(result.mode).toBe('search');
    expect(findMany.mock.calls[0]![0].take).toBe(CLIENT_PICKER_LIMIT + 1);
    expect(names(result)[0]).toBe('Serie 00');

    const exact = await searchClientPickerTx(tx, session(), { query: 'serie 2', filters: [] });
    expect(exact.limited).toBe(false);
  });

  it('übernimmt die Aktiv-/Lebenszyklusregeln der jeweiligen Auswahl', async () => {
    const data = [
      client('Status Aktiv'),
      client('Status GwG offen', { allowActive: false }),
      client('Status Beendet', { mandateEndedAt: new Date('2025-12-31') }),
      client('Status Anonymisiert', { anonymizedAt: new Date('2026-01-31') }),
      client('Status Workflow', { workflowInstances: [{ status: 'ACTIVE' }] }),
      client('Status Workflow fertig', { workflowInstances: [{ status: 'COMPLETED' }] }),
    ];
    const { tx } = fakeTx(data);
    const search = (filters: Parameters<typeof searchClientPickerTx>[2]['filters']) =>
      searchClientPickerTx(tx, session(), { query: 'status', filters }).then(names);

    // Ohne Filter (z. B. Wiedervorlage, Zeiterfassung): alle Zustände, aktive zuerst.
    expect(await search([])).toEqual([
      'Status Aktiv',
      'Status Anonymisiert',
      'Status Beendet',
      'Status Workflow',
      'Status Workflow fertig',
      'Status GwG offen',
    ]);
    // Termin, Rechnung: nur freigegebene Mandanten.
    expect(await search(['active'])).not.toContain('Status GwG offen');
    // Assistent, Posteingang, Vollmacht: aktiv, nicht beendet, nicht anonymisiert.
    expect(await search(['active', 'notEnded', 'notAnonymized'])).toEqual([
      'Status Aktiv',
      'Status Workflow',
      'Status Workflow fertig',
    ]);
    // Lohn, Jahreswechsel: aktiv und nicht beendet (Anonymisierung wie bisher ungeprüft).
    expect(await search(['active', 'notEnded'])).toContain('Status Anonymisiert');
    expect(await search(['activeWorkflow'])).toEqual(['Status Workflow']);
  });

  it('liefert die Statusfelder für Hinweise in der Auswahl', async () => {
    const { tx } = fakeTx([
      client('Hinweis', { allowActive: false, mandateEndedAt: new Date(), datevNo: '1001' }),
    ]);
    const result = await searchClientPickerTx(tx, session(), { query: 'hinweis', filters: [] });
    expect(result.clients[0]).toEqual({
      id: expect.any(String),
      name: 'Hinweis',
      datevNo: '1001',
      addisonNo: null,
      allowActive: false,
      mandateEnded: true,
    });
  });

  it('ordnet bei Namensgleichheit stabil nach ID', async () => {
    const first = client('Gleich');
    const second = client('Gleich');
    const { tx } = fakeTx([second, first]);
    const result = await searchClientPickerTx(tx, session(), { query: 'gleich', filters: [] });
    expect(result.clients.map((c) => c.id)).toEqual([first.id, second.id]);
  });

  it('sucht Name, DATEV- und Addison-Nr. und maskiert LIKE-Metazeichen', async () => {
    const { tx, findMany } = fakeTx([
      client('50% Rabatt GmbH'),
      client('500 Euro KG'),
      client('Nummernkunde', { datevNo: '4711' }),
      client('Addisonkunde', { addisonNo: 'A-77' }),
    ]);
    expect(names(await searchClientPickerTx(tx, session(), { query: '50%', filters: [] }))).toEqual(
      ['50% Rabatt GmbH'],
    );
    expect(
      names(await searchClientPickerTx(tx, session(), { query: '4711', filters: [] })),
    ).toEqual(['Nummernkunde']);
    expect(
      names(await searchClientPickerTx(tx, session(), { query: 'a-77', filters: [] })),
    ).toEqual(['Addisonkunde']);
    expect(JSON.stringify(findMany.mock.calls[0]![0].where)).toContain('50\\\\%');
    expect(escapeLikePattern('a_b\\c%')).toBe('a\\_b\\\\c\\%');
  });

  it('schlägt ohne Suchbegriff nur eigene Zuordnungen vor', async () => {
    const { tx } = fakeTx([
      client('Zugeordnet Fachlich', {
        responsibilities: [{ staffId: 'staff-a', role: 'FACHLICH' }],
      }),
      client('Fremd zugeordnet', {
        responsibilities: [{ staffId: 'staff-b', role: 'BERUFSTRAEGER' }],
      }),
      client('Ohne Zuordnung'),
    ]);
    const result = await searchClientPickerTx(tx, session(), { query: '  ', filters: [] });
    expect(result.mode).toBe('assigned');
    expect(names(result)).toEqual(['Zugeordnet Fachlich']);
  });

  it('prüft für Leerzustände nur die Existenz unter derselben Regel', async () => {
    const { tx, findFirst } = fakeTx([client('Nur vertraulich', { vertraulich: true })]);
    expect(await hasClientPickerOptionTx(tx, session(), ['active'])).toBe(false);
    expect(await hasClientPickerOptionTx(tx, session(['ADMIN']), ['active'])).toBe(true);
    expect(findFirst.mock.calls[0]![0].select).toEqual({ id: true });
  });
});
