// Fachkatalog: TAX-CONTROL-STATUS-001
//
// Review-Finding K-05 (Folgepunkte) gegen echtes PostgreSQL über die App-Rolle
// (RLS). Die Vorabfragen der Bescheidquellen ordnen eine Einlegung in jeder
// Sitzungszeitzone wie filingWithinDeadline ein (UTC-Kalendertag des gespeicherten
// Zeitpunkts), auch kurz vor und nach Mitternacht und über beide Zeitumstellungen
// 2026. Die Begründungsprüfung der Datenbank (app.legal_final_reason_sufficient)
// entspricht begruendungTragfaehig. Fixtures liegen in einem eigenen Tenant; der
// Test läuft nur mit FRISTEN_DB_TEST=1.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '@taxtronik/db';
import { begruendungTragfaehig, filingWithinDeadline, RAND_LEERRAUM_CODEPOINTS } from '../eintrag';
import { einspruchVorab, klageVorab } from '../quellen/bescheid';

const enabled = process.env['FRISTEN_DB_TEST'] === '1';
if (enabled) {
  for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new Error(`FRISTEN_DB_TEST requires a valid ${name}.`);
    }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname.length < 2) {
      throw new Error(`FRISTEN_DB_TEST requires a PostgreSQL ${name}.`);
    }
  }
}

// Einlegungszeitpunkte (UTC) um Mitternacht in UTC und Europe/Berlin sowie über
// die Umstellungen am 29.03. (MEZ→MESZ) und 25.10.2026 (MESZ→MEZ).
const FAELLE: ReadonlyArray<{ filed: string; deadline: string }> = [
  { filed: '2026-03-28T21:30:00.000Z', deadline: '2026-03-28' }, // 22:30 MEZ
  { filed: '2026-03-28T23:30:00.000Z', deadline: '2026-03-28' }, // 00:30 MEZ am 29.03.
  { filed: '2026-03-29T00:30:00.000Z', deadline: '2026-03-28' }, // 01:30 MEZ
  { filed: '2026-03-29T01:30:00.000Z', deadline: '2026-03-29' }, // 03:30 MESZ
  { filed: '2026-10-24T21:30:00.000Z', deadline: '2026-10-24' }, // 23:30 MESZ
  { filed: '2026-10-24T22:30:00.000Z', deadline: '2026-10-24' }, // 00:30 MESZ am 25.10.
  { filed: '2026-10-25T00:30:00.000Z', deadline: '2026-10-24' }, // 02:30 MESZ
  { filed: '2026-10-25T01:30:00.000Z', deadline: '2026-10-25' }, // 02:30 MEZ
  { filed: '2026-06-04T00:00:00.000Z', deadline: '2026-06-04' }, // Ereignistag aus dem Formular
  { filed: '2026-06-05T00:00:00.000Z', deadline: '2026-06-04' }, // einen Tag zu spät
  { filed: '2026-06-04T23:59:59.999Z', deadline: '2026-06-04' },
  { filed: '2026-12-31T23:30:00.000Z', deadline: '2026-12-31' }, // Jahreswechsel
];
const ZEITZONEN = [
  'UTC',
  'Europe/Berlin',
  'America/New_York',
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
] as const;
const HORIZONT = new Date('2027-01-31T00:00:00.000Z');
const tag = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

(enabled ? describe : describe.skip)('Bescheid-Vorabfragen gegen PostgreSQL', () => {
  let db: typeof import('@taxtronik/db');
  let tenantId: string;
  let staffId: string;
  const erwartet = { einspruch: [] as string[], klage: [] as string[] };
  const ctx = (): TenantContext => ({ tenantId, actorId: staffId, actorType: 'STAFF' });

  beforeAll(async () => {
    db = await import('@taxtronik/db');
    tenantId = (
      await db.prismaOwner.tenant.create({
        data: { slug: `fristen-vorab-${randomUUID()}`, name: 'Fristen-Vorabfragen' },
      })
    ).id;
    staffId = (
      await db.prismaOwner.staffUser.create({
        data: {
          tenantId,
          email: `${randomUUID()}@example.test`,
          fullName: 'Fristen Testperson',
          passwordHash: 'unused',
        },
      })
    ).id;
    const clientId = (
      await db.prismaOwner.client.create({
        data: { tenantId, kind: 'NATPERS', name: 'Fristen-Testmandant' },
      })
    ).id;
    const basis = { tenantId, clientId, kind: 'EST' as const, createdByStaff: staffId };
    for (const [i, fall] of FAELLE.entries()) {
      const filedAt = new Date(fall.filed);
      const deadline = tag(fall.deadline);
      const einspruch = await db.prismaOwner.taxNotice.create({
        data: {
          ...basis,
          period: `E-${i}`,
          noticeDate: tag('2026-01-02'),
          status: 'EINSPRUCH',
          appealDeadline: deadline,
          appealFiledAt: filedAt,
          appealFiledBy: staffId,
        },
      });
      const klage = await db.prismaOwner.taxNotice.create({
        data: {
          ...basis,
          period: `K-${i}`,
          noticeDate: tag('2026-01-02'),
          status: 'KLAGE',
          appealFiledAt: tag('2026-01-05'),
          appealFiledBy: staffId,
          appealDecisionReceivedAt: tag('2026-01-10'),
          appealDecisionLegalRemedyInstructionValid: true,
          klageDeadline: deadline,
          klageFiledAt: filedAt,
          klageFiledBy: staffId,
        },
      });
      if (!filingWithinDeadline(filedAt, staffId, deadline)) {
        erwartet.einspruch.push(einspruch.id);
        erwartet.klage.push(klage.id);
      }
    }
    erwartet.einspruch.sort();
    erwartet.klage.sort();
  });

  afterAll(async () => {
    if (!db) return;
    if (tenantId) await db.prismaOwner.tenant.delete({ where: { id: tenantId } });
    await Promise.all([db.prisma.$disconnect(), db.prismaOwner.$disconnect()]);
  });

  it('erkennt verspätete Einlegungen in jeder Sitzungszeitzone wie filingWithinDeadline', async () => {
    // Drei der zwölf Fälle liegen nach dem UTC-Kalendertag des Fristendes.
    expect(erwartet.einspruch).toHaveLength(3);
    for (const zeitzone of ZEITZONEN) {
      const ergebnis = await db.withTenantContext(ctx(), async (tx) => {
        await tx.$queryRaw`SELECT set_config('TimeZone', ${zeitzone}, true)`;
        const [sitzung] = await tx.$queryRaw<Array<{ zone: string }>>`
          SELECT current_setting('TimeZone') AS zone
        `;
        return {
          zone: sitzung?.zone,
          einspruch: await einspruchVorab(tx, HORIZONT),
          klage: await klageVorab(tx, HORIZONT),
        };
      });
      expect(ergebnis.zone).toBe(zeitzone);
      expect(ergebnis.einspruch, zeitzone).toEqual({
        verspaetet: erwartet.einspruch,
        ohneBegruendung: [],
      });
      expect(ergebnis.klage, zeitzone).toEqual({
        verspaetet: erwartet.klage,
        ohneBegruendung: [],
      });
    }
  });

  it('bewertet Begründungen in der Datenbank wie begruendungTragfaehig', async () => {
    const randLeerraum = await db.withTenantContext(
      ctx(),
      (tx) =>
        tx.$queryRaw<Array<{ cp: number }>>`
        SELECT cp FROM generate_series(1, 65535) AS cp
         WHERE cp NOT BETWEEN 55296 AND 57343
           AND NOT app.legal_final_reason_sufficient(repeat(chr(cp), 10))
         ORDER BY cp
      `,
    );
    expect(randLeerraum.map((row) => Number(row.cp))).toEqual([...RAND_LEERRAUM_CODEPOINTS]);

    const zeichen = (...codepoints: number[]) => String.fromCodePoint(...codepoints);
    const proben: Array<string | null> = [
      null,
      '',
      '\t\t\t\t\t\n\n\n\n\n',
      ' 123456789 ',
      '0123456789',
      '\n\t  Akte geprüft \t\n',
      'a b c d e f',
      zeichen(0x1f600).repeat(5),
      zeichen(0x1f600).repeat(10),
      zeichen(0x85).repeat(10),
      ...RAND_LEERRAUM_CODEPOINTS.map((cp) => `${zeichen(cp)}Begründung${zeichen(cp)}`),
      ...RAND_LEERRAUM_CODEPOINTS.map((cp) => `${zeichen(cp).repeat(5)}12345${zeichen(cp)}`),
    ];
    for (const probe of proben) {
      const [zeile] = await db.withTenantContext(
        ctx(),
        (tx) =>
          tx.$queryRaw<Array<{ ok: boolean }>>`
          SELECT app.legal_final_reason_sufficient(${probe}::text) AS ok
        `,
      );
      expect(zeile?.ok, JSON.stringify(probe)).toBe(begruendungTragfaehig(probe));
    }
  });
});
