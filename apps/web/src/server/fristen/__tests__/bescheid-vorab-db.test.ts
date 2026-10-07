// Fachkatalog: TAX-CONTROL-STATUS-001, TAX-NOTICE-APPEAL-001
//
// Review-Finding K-05 (Folgepunkte) gegen echtes PostgreSQL über die App-Rolle
// (RLS). Die Vorabfragen der Bescheidquellen ordnen eine Einlegung in jeder
// Sitzungszeitzone wie filingWithinDeadline ein, auch kurz vor und nach
// Mitternacht und über beide Zeitumstellungen 2026. Seit der Produktentscheidung
// A3 (2026-10-07) ist der Einlegungstag der Berliner Kalendertag des gespeicherten
// Zeitpunkts (§ 108 Abs. 1 AO i. V. m. § 188 BGB). Dieselbe Ableitung nutzen der
// Statusübergangs-Trigger (app.tax_notice_require_progress_evidence) und die
// Constraints tax_notice_legal_final_evidence_check und
// tax_notice_event_sequence_check (Migration 20261007110000); sie werden hier an
// den Tagesgrenzen geprüft. Die Begründungsprüfung der Datenbank
// (app.legal_final_reason_sufficient) entspricht begruendungTragfaehig. Die
// Seitenansicht des Kontrollbuchs blättert offene und erledigte Einträge genau
// wie die vollständige Sicht (Folgepunkt „Mit Erledigten“). Fixtures liegen in
// einem eigenen Tenant; der Test läuft nur mit FRISTEN_DB_TEST=1.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@taxtronik/db';
import { berlinCalendarDate } from '@taxtronik/tax';
import type { StaffSession } from '@/server/auth/staff';
import {
  begruendungTragfaehig,
  filingWithinDeadline,
  type FristEintrag,
  RAND_LEERRAUM_CODEPOINTS,
} from '../eintrag';
import { loadKontrollbuch, loadKontrollbuchSeite } from '../kontrollbuch';
import { einspruchVorab, klageVorab } from '../quellen/bescheid';

// Sichtbarkeitsregel wie accessibleClientsWhereFor (ADMIN ohne Einschränkung,
// sonst OPEN-Modus); vermeidet den Auth-Stack, die Abfragen laufen echt.
vi.mock('@/server/auth/rbac', () => ({
  accessibleClientsWhereFor: async (
    _tx: unknown,
    session: { user: { staffId: string; roles: string[] } },
  ) =>
    session.user.roles.includes('ADMIN')
      ? {}
      : {
          OR: [
            { vertraulich: false },
            {
              responsibilities: {
                some: {
                  staffId: session.user.staffId,
                  role: { in: ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] },
                },
              },
            },
          ],
        },
}));

// B-02: lokal per FRISTEN_DB_TEST=1, im db-CI-Job per DB_TESTS=1 (Glob über alle
// *-db.test.ts). In CI scheitert die Suite ohne Opt-in, statt still übersprungen zu werden.
const enabled = process.env['FRISTEN_DB_TEST'] === '1' || process.env['DB_TESTS'] === '1';
if (!enabled && process.env['CI'] === 'true') {
  throw new Error(
    'FRISTEN_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}
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
// die Umstellungen am 29.03. (MEZ→MESZ) und 25.10.2026 (MESZ→MEZ). `verspaetet`
// folgt dem Berliner Kalendertag der Einlegung.
const FAELLE: ReadonlyArray<{ filed: string; deadline: string; verspaetet: boolean }> = [
  { filed: '2026-03-28T21:30:00.000Z', deadline: '2026-03-28', verspaetet: false }, // 22:30 MEZ
  { filed: '2026-03-28T23:30:00.000Z', deadline: '2026-03-28', verspaetet: true }, // 00:30 MEZ am 29.03.
  { filed: '2026-03-29T00:30:00.000Z', deadline: '2026-03-28', verspaetet: true }, // 01:30 MEZ am 29.03.
  { filed: '2026-03-29T01:30:00.000Z', deadline: '2026-03-29', verspaetet: false }, // 03:30 MESZ
  { filed: '2026-10-24T21:30:00.000Z', deadline: '2026-10-24', verspaetet: false }, // 23:30 MESZ
  { filed: '2026-10-24T22:30:00.000Z', deadline: '2026-10-24', verspaetet: true }, // 00:30 MESZ am 25.10.
  { filed: '2026-10-25T00:30:00.000Z', deadline: '2026-10-24', verspaetet: true }, // 02:30 MESZ am 25.10.
  { filed: '2026-10-25T01:30:00.000Z', deadline: '2026-10-25', verspaetet: false }, // 02:30 MEZ
  { filed: '2026-06-04T00:00:00.000Z', deadline: '2026-06-04', verspaetet: false }, // Ereignistag aus dem Formular
  { filed: '2026-06-05T00:00:00.000Z', deadline: '2026-06-04', verspaetet: true }, // einen Tag zu spät
  { filed: '2026-06-04T23:59:59.999Z', deadline: '2026-06-04', verspaetet: true }, // 01:59 MESZ am 05.06.
  { filed: '2026-12-31T23:30:00.000Z', deadline: '2026-12-31', verspaetet: true }, // 00:30 MEZ am 01.01.
];
const ZEITZONEN = [
  'UTC',
  'Europe/Berlin',
  'America/New_York',
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
] as const;
const HORIZONT = new Date('2027-01-31T00:00:00.000Z');
const TAG_MS = 24 * 60 * 60 * 1000;
const tag = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const isoTag = (date: Date) => date.toISOString().slice(0, 10);

// Pflichtangaben eines berechneten Kontrollvorschlags (siehe Constraints
// tax_notice_calculation_result_check und tax_notice_input_documentation_check).
const BESTAETIGTE_KONTEXTE = {
  recipientName: 'Empfangsbevollmächtigte Kanzlei',
  recipientCountryCode: 'DE',
  recipientRegion: 'DE-BE',
  recipientLocality: 'Berlin',
  recipientHolidayContextStatus: 'CONFIRMED_FOR_DATE_AND_LOCATION' as const,
  authorityName: 'Finanzamt Berlin',
  authorityCountryCode: 'DE',
  authorityRegion: 'DE-BE',
  authorityLocality: 'Berlin',
  authorityHolidayContextStatus: 'CONFIRMED_FOR_DATE_AND_LOCATION' as const,
  holidayContextNote: 'Örtliche Feiertage für Datum und beide Orte geprüft.',
  deliveryEvidenceNote: 'Ausgangsvorgang anhand der Akte geprüft.',
  legalRemedyInstructionNote: 'Pflichtangaben und Einzelfall geprüft.',
};
const BEGRUENDUNG = 'Fristablauf und Aktenlage fachlich geprüft.';

(enabled ? describe : describe.skip)('Bescheid-Vorabfragen gegen PostgreSQL', () => {
  let db: typeof import('@taxtronik/db');
  let tenantId: string;
  let staffId: string;
  let clientId: string;
  let periode = 0;
  const erwartet = { einspruch: [] as string[], klage: [] as string[] };
  const eingelegt = { einspruch: new Map<string, Date>(), klage: new Map<string, Date>() };
  const ctx = (): TenantContext => ({ tenantId, actorId: staffId, actorType: 'STAFF' });
  const basis = (praefix: string) => ({
    tenantId,
    clientId,
    kind: 'EST' as const,
    period: `${praefix}-${++periode}`,
    createdByStaff: staffId,
  });

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
    clientId = (
      await db.prismaOwner.client.create({
        data: { tenantId, kind: 'NATPERS', name: 'Fristen-Testmandant' },
      })
    ).id;
    for (const fall of FAELLE) {
      const filedAt = new Date(fall.filed);
      const deadline = tag(fall.deadline);
      const einspruch = await db.prismaOwner.taxNotice.create({
        data: {
          ...basis('E'),
          noticeDate: tag('2026-01-02'),
          status: 'EINSPRUCH',
          appealDeadline: deadline,
          appealFiledAt: filedAt,
          appealFiledBy: staffId,
        },
      });
      const klage = await db.prismaOwner.taxNotice.create({
        data: {
          ...basis('K'),
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
      eingelegt.einspruch.set(einspruch.id, filedAt);
      eingelegt.klage.set(klage.id, filedAt);
      if (fall.verspaetet) {
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
    for (const fall of FAELLE) {
      expect(
        filingWithinDeadline(new Date(fall.filed), staffId, tag(fall.deadline)),
        fall.filed,
      ).toBe(!fall.verspaetet);
    }
    // Sieben der zwölf Fälle liegen nach dem Berliner Kalendertag des Fristendes;
    // nach dem früheren UTC-Tag waren es drei.
    expect(erwartet.einspruch).toHaveLength(7);
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

  it('leitet den Berliner Kalendertag in jeder Sitzungszeitzone wie berlinCalendarDate ab', async () => {
    for (const zeitzone of ZEITZONEN) {
      const zeilen = await db.withTenantContext(ctx(), async (tx) => {
        await tx.$queryRaw`SELECT set_config('TimeZone', ${zeitzone}, true)`;
        return tx.$queryRaw<Array<{ id: string; einspruchTag: string; klageTag: string | null }>>`
          SELECT "id"::text AS "id",
                 ((("appeal_filed_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date)::text
                   AS "einspruchTag",
                 ((("klage_filed_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date)::text
                   AS "klageTag"
            FROM public."tax_notice"
           WHERE "appeal_filed_at" IS NOT NULL
        `;
      });
      const tage = new Map(zeilen.map((zeile) => [zeile.id, zeile]));
      for (const [id, filedAt] of eingelegt.einspruch) {
        expect(tage.get(id)?.einspruchTag, `${zeitzone} ${filedAt.toISOString()}`).toBe(
          isoTag(berlinCalendarDate(filedAt)),
        );
      }
      for (const [id, filedAt] of eingelegt.klage) {
        expect(tage.get(id)?.klageTag, `${zeitzone} ${filedAt.toISOString()}`).toBe(
          isoTag(berlinCalendarDate(filedAt)),
        );
      }
    }
  });

  async function geprueft(fristende: string) {
    const appealDeadline = tag(fristende);
    const noticeDate = new Date(appealDeadline.getTime() - 40 * TAG_MS);
    return db.prismaOwner.taxNotice.create({
      data: {
        ...basis('G'),
        ...BESTAETIGTE_KONTEXTE,
        noticeDate,
        status: 'GEPRUEFT',
        reviewedAt: noticeDate,
        reviewedBy: staffId,
        dateBasis: 'DISPATCH_DATE',
        deliveryEvidenceStatus: 'SUBSTANTIATED',
        legalRemedyInstructionStatus: 'WIRKSAM',
        calculatedNotificationDate: new Date(noticeDate.getTime() + 4 * TAG_MS),
        appealDeadline,
        deadlineCalculationStatus: 'CALCULATED',
        deadlineCalculationVersion: 'tax-legal-assessment/2026-08-23-v1',
        manualReviewRequired: false,
      },
    });
  }

  // [Fristende, Bestandskraft (UTC), zulässig]: Ablauf des Fristtags in Berliner Zeit,
  // im Sommer und Winter, mit Formularwerten (00:00 UTC) und an beiden Umstellungstagen.
  const BESTANDSKRAFT: ReadonlyArray<[string, string, boolean]> = [
    ['2026-07-06', '2026-07-06T21:30:00.000Z', false], // 23:30 MESZ am Fristtag
    ['2026-07-06', '2026-07-06T22:30:00.000Z', true], // 00:30 MESZ am Folgetag
    ['2026-02-10', '2026-02-10T22:30:00.000Z', false], // 23:30 MEZ am Fristtag
    ['2026-02-10', '2026-02-10T23:30:00.000Z', true], // 00:30 MEZ am Folgetag
    ['2026-02-10', '2026-02-10T00:00:00.000Z', false], // Formularwert am Fristtag
    ['2026-02-10', '2026-02-11T00:00:00.000Z', true], // Formularwert am Folgetag
    ['2026-03-28', '2026-03-28T22:59:59.999Z', false], // 23:59 MEZ vor der Umstellung
    ['2026-03-28', '2026-03-28T23:00:00.000Z', true], // 00:00 MEZ am 29.03.
    ['2026-10-25', '2026-10-25T22:59:59.999Z', false], // 23:59 MEZ am Umstellungstag
    ['2026-10-25', '2026-10-25T23:00:00.000Z', true], // 00:00 MEZ am 26.10.
  ];

  it('lässt Bestandskraft ohne Einspruch erst nach Ablauf des Fristtags in Berliner Zeit zu', async () => {
    for (const [fristende, bestandskraft, zulaessig] of BESTANDSKRAFT) {
      const notice = await geprueft(fristende);
      const update = db.prismaOwner.taxNotice.update({
        where: { id: notice.id },
        data: {
          status: 'BESTANDSKRAEFTIG',
          legalFinalAt: new Date(bestandskraft),
          legalFinalBy: staffId,
          legalFinalReason: BEGRUENDUNG,
        },
      });
      if (zulaessig) {
        await expect(update, bestandskraft).resolves.toMatchObject({ status: 'BESTANDSKRAEFTIG' });
      } else {
        await expect(update, bestandskraft).rejects.toThrow(
          /elapsed, fully calculated appeal deadline/,
        );
      }
    }
  });

  it('prüft die Bestandskraft-Constraint auch ohne Statuswechsel nach Berliner Tag', async () => {
    for (const [fristende, bestandskraft, zulaessig] of BESTANDSKRAFT) {
      const appealDeadline = tag(fristende);
      const noticeDate = new Date(appealDeadline.getTime() - 40 * TAG_MS);
      // Direkter Insert: Der Statusübergangs-Trigger greift nicht, nur die Constraint.
      const insert = db.prismaOwner.taxNotice.create({
        data: {
          ...basis('B'),
          ...BESTAETIGTE_KONTEXTE,
          noticeDate,
          status: 'BESTANDSKRAEFTIG',
          reviewedAt: noticeDate,
          reviewedBy: staffId,
          dateBasis: 'DISPATCH_DATE',
          deliveryEvidenceStatus: 'SUBSTANTIATED',
          legalRemedyInstructionStatus: 'WIRKSAM',
          calculatedNotificationDate: new Date(noticeDate.getTime() + 4 * TAG_MS),
          appealDeadline,
          deadlineCalculationStatus: 'CALCULATED',
          deadlineCalculationVersion: 'tax-legal-assessment/2026-08-23-v1',
          manualReviewRequired: false,
          legalFinalAt: new Date(bestandskraft),
          legalFinalBy: staffId,
          legalFinalReason: BEGRUENDUNG,
        },
      });
      if (zulaessig) {
        await expect(insert, bestandskraft).resolves.toMatchObject({ status: 'BESTANDSKRAEFTIG' });
      } else {
        await expect(insert, bestandskraft).rejects.toThrow(
          /tax_notice_legal_final_evidence_check/,
        );
      }
    }
  });

  it('lässt Bestandskraft nach Zurückweisung erst nach Ablauf der Klagefrist in Berliner Zeit zu', async () => {
    const faelle: ReadonlyArray<[string, string, boolean]> = [
      ['2026-02-10', '2026-02-10T22:30:00.000Z', false], // 23:30 MEZ am Fristtag
      ['2026-02-10', '2026-02-10T23:30:00.000Z', true], // 00:30 MEZ am Folgetag
      ['2026-07-06', '2026-07-06T21:30:00.000Z', false], // 23:30 MESZ am Fristtag
      ['2026-07-06', '2026-07-06T22:30:00.000Z', true], // 00:30 MESZ am Folgetag
    ];
    for (const [fristende, bestandskraft, zulaessig] of faelle) {
      const klageDeadline = tag(fristende);
      const entscheidung = new Date(klageDeadline.getTime() - 30 * TAG_MS);
      const notice = await db.prismaOwner.taxNotice.create({
        data: {
          ...basis('Z'),
          noticeDate: new Date(entscheidung.getTime() - 60 * TAG_MS),
          status: 'ZURUECKGEWIESEN',
          appealFiledAt: new Date(entscheidung.getTime() - 50 * TAG_MS),
          appealFiledBy: staffId,
          appealResolvedAt: entscheidung,
          appealDecisionReceivedAt: entscheidung,
          appealDecisionLegalRemedyInstructionValid: true,
          klageDeadline,
        },
      });
      const update = db.prismaOwner.taxNotice.update({
        where: { id: notice.id },
        data: {
          status: 'BESTANDSKRAEFTIG',
          legalFinalAt: new Date(bestandskraft),
          legalFinalBy: staffId,
          legalFinalReason: BEGRUENDUNG,
        },
      });
      if (zulaessig) {
        await expect(update, bestandskraft).resolves.toMatchObject({ status: 'BESTANDSKRAEFTIG' });
      } else {
        await expect(update, bestandskraft).rejects.toThrow(/elapsed court deadline/);
      }
    }
  });

  it('prüft die Ereignisreihenfolge nach dem Berliner Tag der Einlegung', async () => {
    // 23:30 Uhr UTC am 28.03. ist 00:30 Uhr MEZ am 29.03.
    const eingelegtAm = new Date('2026-03-28T23:30:00.000Z');
    const einspruch = (data: Record<string, unknown>) =>
      db.prismaOwner.taxNotice.create({
        data: {
          ...basis('R'),
          noticeDate: tag('2026-03-02'),
          status: 'EINSPRUCH',
          appealFiledAt: eingelegtAm,
          appealFiledBy: staffId,
          ...data,
        },
      });
    // Bescheiddatum am Berliner Einlegungstag: zulässig (nach UTC-Tag lag die
    // Einlegung davor).
    await expect(einspruch({ noticeDate: tag('2026-03-29') })).resolves.toMatchObject({
      status: 'EINSPRUCH',
    });
    await expect(einspruch({ noticeDate: tag('2026-03-30') })).rejects.toThrow(
      /tax_notice_event_sequence_check/,
    );
    // Teilabhilfe vom 28.03. läge vor der Einlegung am 29.03. (nach UTC-Tag zulässig).
    const teilabhilfe = (ymd: string) =>
      einspruch({
        status: 'TEILABHILFE',
        partialReliefReceivedAt: tag(ymd),
        partialReliefReceivedBy: staffId,
      });
    await expect(teilabhilfe('2026-03-28')).rejects.toThrow(/tax_notice_event_sequence_check/);
    await expect(teilabhilfe('2026-03-29')).resolves.toMatchObject({ status: 'TEILABHILFE' });
  });

  it('vergleicht die Abhilfe nach Teilabhilfe mit dem Berliner Tag', async () => {
    const teilabhilfe = () =>
      db.prismaOwner.taxNotice.create({
        data: {
          ...basis('T'),
          noticeDate: tag('2026-01-02'),
          status: 'TEILABHILFE',
          appealFiledAt: tag('2026-01-20'),
          appealFiledBy: staffId,
          partialReliefReceivedAt: tag('2026-02-10'),
          partialReliefReceivedBy: staffId,
        },
      });
    const abhilfe = async (resolvedAt: string) => {
      const notice = await teilabhilfe();
      return db.prismaOwner.taxNotice.update({
        where: { id: notice.id },
        data: { status: 'ABGEHOLFEN', appealResolvedAt: new Date(resolvedAt) },
      });
    };
    // 23:30 Uhr MEZ am 09.02. liegt vor der Teilabhilfe vom 10.02.
    await expect(abhilfe('2026-02-09T22:30:00.000Z')).rejects.toThrow(
      /must not predate the partial relief receipt/,
    );
    // 00:30 Uhr MEZ am 10.02. ist der Tag der Teilabhilfe (nach UTC-Tag der 09.02.).
    await expect(abhilfe('2026-02-09T23:30:00.000Z')).resolves.toMatchObject({
      status: 'ABGEHOLFEN',
    });
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

  // Fachkatalog: TAX-CONTROL-STATUS-001 — Review-Befund K-05: Die Seite blättert
  // offene (aufsteigend) und erledigte Einträge (absteigend) getrennt. Mit den
  // Bescheiden dieses Tests (verspätete und fristgerechte Einlegungen,
  // Bestandskraft) sowie Steuerterminen, Anforderungen und Wiedervorlagen mit
  // vielen gleichen Fälligkeiten ergeben alle Seiten zusammen genau die Einträge
  // von loadKontrollbuch in derselben Reihenfolge (App-Rolle, REPEATABLE READ).
  it('blättert offene und erledigte Einträge genau wie die vollständige Sicht', async () => {
    const { createVerifiedLegalEntityGwgFixture } =
      await import('../../../../../../packages/db/src/__tests__/gwg-test-fixture');
    const aktiv = (
      await db.prismaOwner.client.create({
        data: { tenantId, kind: 'JURPERS', name: 'Fristen-Seitenmandant GmbH' },
      })
    ).id;
    await createVerifiedLegalEntityGwgFixture(db.prismaOwner as never, {
      tenantId,
      clientId: aktiv,
      verifiedBy: staffId,
    });
    await db.prismaOwner.client.update({ where: { id: aktiv }, data: { allowActive: true } });
    const vertraulich = (
      await db.prismaOwner.client.create({
        data: { tenantId, kind: 'NATPERS', name: 'Vertraulicher Mandant', vertraulich: true },
      })
    ).id;
    await db.prismaOwner.clientResponsibility.create({
      data: { tenantId, clientId: aktiv, staffId, role: 'HAUPTBEARBEITER' },
    });

    const stichtag = tag('2026-07-16');
    // Viele Gleichstände um den Stichtag, dazu Fälligkeiten außerhalb von 7/30/90 Tagen.
    const versatz = [-100, -60, -30, -8, -3, 0, 0, 2, 7, 7, 25, 60, 95];
    const am = (i: number, stunden = 0) =>
      new Date(stichtag.getTime() + versatz[i % versatz.length]! * TAG_MS + stunden * 3_600_000);
    const mandanten = [clientId, aktiv, vertraulich];
    const erledigtAm = new Date('2026-07-01T09:00:00.000Z');
    for (let i = 0; i < 39; i++) {
      const variante = i % 4;
      await db.prismaOwner.taxDeadline.create({
        data: {
          tenantId,
          clientId: mandanten[i % 3]!,
          kind: 'USTA_MONATLICH',
          period: `Seite-${i}`,
          dueDate: am(i),
          status: variante === 2 ? 'PLANNED' : variante === 3 ? 'SKIPPED' : 'DONE',
          completedAt: variante <= 1 ? erledigtAm : null,
          // Variante 1: DONE ohne handelnde Person bleibt offen.
          completedByStaff: variante === 0 ? staffId : null,
        },
      });
      await db.prismaOwner.clientReminder.create({
        data: {
          tenantId,
          clientId: mandanten[(i + 1) % 3]!,
          dueDate: am(i + 5),
          subject: `Wiedervorlage ${i}`,
          createdByStaff: staffId,
          doneAt: variante <= 1 ? erledigtAm : null,
          doneByStaff: variante === 0 ? staffId : null,
        },
      });
    }
    for (let i = 0; i < 26; i++) {
      const status = (['CLOSED', 'OPEN', 'RESPONDED', 'CANCELLED', 'CLOSED'] as const)[i % 5]!;
      await db.prismaOwner.request.create({
        data: {
          tenantId,
          clientId: aktiv,
          title: `Anforderung ${i}`,
          description: 'Kontrollbuch-Seitentest',
          createdByStaff: staffId,
          // Gleiche Zeitpunkte paarweise: Gleichstände auch bei Zeitstempeln.
          dueAt: am(i, i % 2),
          status,
          closedAt: status === 'CLOSED' ? erledigtAm : null,
          // Das zweite CLOSED ohne handelnde Person bleibt offen.
          closedByStaff: status === 'CLOSED' && i % 5 === 0 ? staffId : null,
        },
      });
    }

    const sessions: Record<string, StaffSession> = {
      admin: { user: { tenantId, staffId, roles: ['ADMIN'], permissions: [] } },
      mitarbeiter: { user: { tenantId, staffId, roles: ['EMPLOYEE'], permissions: [] } },
    } as unknown as Record<string, StaffSession>;
    let geprueft = 0;
    let erledigtGesehen = 0;
    for (const referenceDate of [stichtag, tag('2026-06-04')]) {
      for (const tage of [7, 30, 90]) {
        for (const nurOffene of [false, true]) {
          for (const [rolle, session] of Object.entries(sessions)) {
            const fall = `${isoTag(referenceDate)} ${tage} ${nurOffene} ${rolle}`;
            await db.withTenantContext(
              ctx(),
              async (tx) => {
                const opts = { tage, nurOffene, referenceDate };
                const voll = await loadKontrollbuch(tx, session, opts);
                const offen = voll.filter((e) => !e.erledigt);
                const erledigt = voll.filter((e) => e.erledigt);
                erledigtGesehen += erledigt.length;
                for (const seitenGroesse of [4, 9]) {
                  const seiten: FristEintrag[] = [];
                  for (let seite = 1; ; seite += 1) {
                    const r = await loadKontrollbuchSeite(tx, session, {
                      ...opts,
                      seite,
                      seitenGroesse,
                    });
                    expect(r.offenGesamt, fall).toBe(offen.length);
                    expect(r.erledigtGesamt, fall).toBe(erledigt.length);
                    seiten.push(...r.offen);
                    if (seite * seitenGroesse >= offen.length) break;
                  }
                  const erledigtSeiten: FristEintrag[] = [];
                  for (let erledigtSeite = 1; ; erledigtSeite += 1) {
                    const r = await loadKontrollbuchSeite(tx, session, {
                      ...opts,
                      seite: 1,
                      erledigtSeite,
                      seitenGroesse,
                    });
                    expect(r.erledigtSeite, fall).toBe(erledigtSeite);
                    erledigtSeiten.push(...r.erledigt);
                    if (erledigtSeite * seitenGroesse >= erledigt.length) break;
                  }
                  expect(seiten, fall).toEqual(offen);
                  expect(erledigtSeiten, fall).toEqual(erledigt);
                  geprueft += 1;
                }
              },
              { isolationLevel: 'RepeatableRead', timeout: 60_000 },
            );
          }
        }
      }
    }
    expect(geprueft).toBe(2 * 3 * 2 * 2 * 2);
    // Der Bestand enthält tatsächlich mehrseitige Erledigt-Listen.
    expect(erledigtGesehen).toBeGreaterThan(100);
  }, 180_000);
});
