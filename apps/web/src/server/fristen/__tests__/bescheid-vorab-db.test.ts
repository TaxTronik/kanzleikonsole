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
// (app.legal_final_reason_sufficient) entspricht begruendungTragfaehig. Fixtures
// liegen in einem eigenen Tenant; der Test läuft nur mit FRISTEN_DB_TEST=1.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '@taxtronik/db';
import { berlinCalendarDate } from '@taxtronik/tax';
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
});
