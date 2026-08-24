import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';

const hasDatabase = Boolean(process.env['DATABASE_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Bescheid-Nachweis-Test braucht DATABASE_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

let tenantId: string;
let clientId: string;
let staffId: string;
let counter = 0;

beforeAll(async () => {
  const tenant = await owner.tenant.create({
    data: { slug: `test-tax-notice-evidence-${Date.now()}`, name: 'Bescheid-Nachweis Test' },
  });
  tenantId = tenant.id;
  staffId = (
    await owner.staffUser.create({
      data: {
        tenantId,
        email: `tax-notice-evidence-${Date.now()}@test.local`,
        fullName: 'Bescheid Test Staff',
        passwordHash: 'x',
      },
    })
  ).id;
  clientId = (
    await owner.client.create({
      data: { tenantId, kind: 'NATPERS', name: 'Bescheid-Testmandant' },
    })
  ).id;
});

afterAll(async () => {
  if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
  await owner.$disconnect();
});

function baseNotice() {
  counter += 1;
  return {
    tenantId,
    clientId,
    kind: 'EST' as const,
    period: `2026-${counter}`,
    noticeDate: new Date('2026-06-01T00:00:00.000Z'),
    createdByStaff: staffId,
  };
}

const engineVersion = 'tax-legal-assessment/2026-08-23-v1';

function confirmedHolidayContexts() {
  return {
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
}

describeWithDatabase('Beweisorientiertes Bescheidmodell', () => {
  // Fachkatalog: TAX-NOTICE-DATARETRIEVAL-001
  it('persistiert einen nachgewiesenen §122a-Kontrollvorschlag mit Engine-Version', async () => {
    const notice = await owner.taxNotice.create({
      data: {
        ...baseNotice(),
        ...confirmedHolidayContexts(),
        noticeDate: new Date('2026-03-10T00:00:00.000Z'),
        dateBasis: 'PROVISION_DATE',
        deliveryMethod: 'DATA_RETRIEVAL',
        deliveryEvidenceStatus: 'SUBSTANTIATED',
        deliveryEvidenceNote: 'Bereitstellungsprotokoll der Finanzverwaltung',
        legalRemedyInstructionStatus: 'WIRKSAM',
        legalRemedyInstructionValid: true,
        legalRemedyInstructionNote: 'Pflichtangaben geprüft',
        retrievalIssuedAt: new Date('2026-03-09T00:00:00.000Z'),
        retrievalConsentStatus: 'CONFIRMED',
        retrievalNotificationStatus: 'SENT',
        retrievalNotificationDate: new Date('2026-03-10T00:00:00.000Z'),
        calculatedNotificationDate: new Date('2026-03-16T00:00:00.000Z'),
        appealDeadline: new Date('2026-04-16T00:00:00.000Z'),
        deadlineCalculationStatus: 'CALCULATED',
        deadlineCalculationVersion: engineVersion,
        manualReviewRequired: true,
        manualReviewReason: 'PROVISION_PROFESSIONAL_APPROVAL_PENDING',
      },
    });

    expect(notice).toMatchObject({
      deadlineCalculationStatus: 'CALCULATED',
      deadlineCalculationVersion: engineVersion,
      manualReviewRequired: true,
    });
  });

  it('kennzeichnet einen rein technischen Bereitstellungsnachweis als fachlich offen', async () => {
    await expect(
      owner.taxNotice.create({
        data: {
          ...baseNotice(),
          ...confirmedHolidayContexts(),
          noticeDate: new Date('2026-03-10T00:00:00.000Z'),
          dateBasis: 'PROVISION_DATE',
          deliveryMethod: 'DATA_RETRIEVAL',
          deliveryEvidenceStatus: 'SUBSTANTIATED',
          deliveryEvidenceNote: 'Bereitstellungsprotokoll der Finanzverwaltung',
          legalRemedyInstructionStatus: 'WIRKSAM',
          legalRemedyInstructionValid: true,
          retrievalIssuedAt: new Date('2026-03-09T00:00:00.000Z'),
          retrievalConsentStatus: 'CONFIRMED',
          retrievalNotificationStatus: 'SENT',
          retrievalNotificationDate: new Date('2026-03-10T00:00:00.000Z'),
          calculatedNotificationDate: new Date('2026-03-16T00:00:00.000Z'),
          appealDeadline: new Date('2026-04-16T00:00:00.000Z'),
          deadlineCalculationStatus: 'CALCULATED',
          deadlineCalculationVersion: engineVersion,
          manualReviewRequired: false,
        },
      }),
    ).rejects.toThrow();
  });

  it('erlaubt im Altrecht den festgestellten Abruf bei streitiger Benachrichtigung', async () => {
    await expect(
      owner.taxNotice.create({
        data: {
          ...baseNotice(),
          ...confirmedHolidayContexts(),
          noticeDate: new Date('2025-01-10T00:00:00.000Z'),
          dateBasis: 'PROVISION_DATE',
          deliveryMethod: 'DATA_RETRIEVAL',
          deliveryEvidenceStatus: 'PROFESSIONALLY_DETERMINED',
          legalRemedyInstructionStatus: 'WIRKSAM',
          retrievalIssuedAt: new Date('2025-01-09T00:00:00.000Z'),
          retrievalNotificationDisputedOrLate: true,
          retrievedAt: new Date('2025-01-20T00:00:00.000Z'),
          calculatedNotificationDate: new Date('2025-01-20T00:00:00.000Z'),
          appealDeadline: new Date('2025-02-20T00:00:00.000Z'),
          deadlineCalculationStatus: 'CALCULATED',
          deadlineCalculationVersion: engineVersion,
          manualReviewRequired: false,
        },
      }),
    ).resolves.toMatchObject({ deliveryMethod: 'DATA_RETRIEVAL' });
  });

  it('berechnet im unstreitigen Altrecht nur bei bestätigtem Benachrichtigungsversand', async () => {
    const legacyNotification = () => ({
      ...baseNotice(),
      ...confirmedHolidayContexts(),
      noticeDate: new Date('2025-01-10T00:00:00.000Z'),
      dateBasis: 'PROVISION_DATE' as const,
      deliveryMethod: 'DATA_RETRIEVAL',
      deliveryEvidenceStatus: 'PROFESSIONALLY_DETERMINED' as const,
      legalRemedyInstructionStatus: 'WIRKSAM' as const,
      retrievalIssuedAt: new Date('2025-01-09T00:00:00.000Z'),
      retrievalNotificationDate: new Date('2025-01-10T00:00:00.000Z'),
      deadlineCalculationVersion: engineVersion,
    });

    await expect(
      owner.taxNotice.create({
        data: {
          ...legacyNotification(),
          retrievalNotificationStatus: 'FAILED',
          calculatedNotificationDate: new Date('2025-01-14T00:00:00.000Z'),
          appealDeadline: new Date('2025-02-14T00:00:00.000Z'),
          deadlineCalculationStatus: 'CALCULATED',
          manualReviewRequired: false,
        },
      }),
    ).rejects.toThrow();

    await expect(
      owner.taxNotice.create({
        data: {
          ...legacyNotification(),
          retrievalNotificationStatus: 'FAILED',
          deadlineCalculationStatus: 'MANUAL_REVIEW',
          manualReviewRequired: true,
          manualReviewReason: 'LEGACY_NOTIFICATION_OUTCOME_NOT_CONFIRMED',
        },
      }),
    ).resolves.toMatchObject({
      deadlineCalculationStatus: 'MANUAL_REVIEW',
      retrievalNotificationStatus: 'FAILED',
    });

    await expect(
      owner.taxNotice.create({
        data: {
          ...legacyNotification(),
          retrievalNotificationStatus: 'SENT',
          calculatedNotificationDate: new Date('2025-01-14T00:00:00.000Z'),
          appealDeadline: new Date('2025-02-14T00:00:00.000Z'),
          deadlineCalculationStatus: 'CALCULATED',
          manualReviewRequired: false,
        },
      }),
    ).resolves.toMatchObject({ deadlineCalculationStatus: 'CALCULATED' });
  });

  it('erzwingt für Benachrichtigungsabweichungen ab 2026 eine dokumentierte Prüfspur', async () => {
    const newRetrievalNotice = () => ({
      ...baseNotice(),
      ...confirmedHolidayContexts(),
      noticeDate: new Date('2026-03-10T00:00:00.000Z'),
      dateBasis: 'PROVISION_DATE' as const,
      deliveryMethod: 'DATA_RETRIEVAL',
      deliveryEvidenceStatus: 'SUBSTANTIATED' as const,
      legalRemedyInstructionStatus: 'WIRKSAM' as const,
      legalRemedyInstructionValid: true,
      retrievalIssuedAt: new Date('2026-03-09T00:00:00.000Z'),
      retrievalConsentStatus: 'CONFIRMED' as const,
      calculatedNotificationDate: new Date('2026-03-16T00:00:00.000Z'),
      appealDeadline: new Date('2026-04-16T00:00:00.000Z'),
      deadlineCalculationStatus: 'CALCULATED' as const,
      deadlineCalculationVersion: engineVersion,
    });

    await expect(
      owner.taxNotice.create({
        data: {
          ...newRetrievalNotice(),
          retrievalNotificationStatus: 'NOT_RECORDED',
          manualReviewRequired: false,
        },
      }),
    ).rejects.toThrow();

    await expect(
      owner.taxNotice.create({
        data: {
          ...newRetrievalNotice(),
          retrievalNotificationStatus: 'SENT',
          retrievalNotificationDate: new Date('2026-03-11T00:00:00.000Z'),
          manualReviewRequired: false,
        },
      }),
    ).rejects.toThrow();

    await expect(
      owner.taxNotice.create({
        data: {
          ...newRetrievalNotice(),
          retrievalNotificationStatus: 'SENT',
          retrievalNotificationDate: new Date('2026-03-11T00:00:00.000Z'),
          retrievalReinstatementReviewRequired: true,
          manualReviewRequired: true,
          manualReviewReason: 'Verspätete Benachrichtigung; § 110 AO manuell prüfen.',
        },
      }),
    ).resolves.toMatchObject({
      retrievalNotificationStatus: 'SENT',
      retrievalReinstatementReviewRequired: true,
      manualReviewRequired: true,
    });
  });

  it('blockiert eine berechnete Frist ohne Nachweis und bestätigte Orte', async () => {
    await expect(
      owner.taxNotice.create({
        data: {
          ...baseNotice(),
          dateBasis: 'DISPATCH_DATE',
          appealDeadline: new Date('2026-07-06T00:00:00.000Z'),
          calculatedNotificationDate: new Date('2026-06-05T00:00:00.000Z'),
          deadlineCalculationStatus: 'CALCULATED',
          deadlineCalculationVersion: engineVersion,
          manualReviewRequired: false,
        },
      }),
    ).rejects.toThrow();
  });

  it('bindet jede Zugangseinwendung an einen Nachweisstatus und verhindert Streunachweise', async () => {
    await expect(
      owner.taxNotice.create({
        data: {
          ...baseNotice(),
          accessStatus: 'NOT_RECEIVED_DISPUTED',
        },
      }),
    ).rejects.toThrow();

    await expect(
      owner.taxNotice.create({
        data: {
          ...baseNotice(),
          accessStatus: 'NOT_RECEIVED_DISPUTED',
          accessEvidenceStatus: 'CLAIMED',
        },
      }),
    ).rejects.toThrow();

    await expect(
      owner.taxNotice.create({
        data: {
          ...baseNotice(),
          accessStatus: 'NOT_RECEIVED_DISPUTED',
          accessEvidenceStatus: 'CLAIMED',
          accessEvidenceNote: 'Mandant bestreitet den Zugang nachvollziehbar.',
        },
      }),
    ).resolves.toMatchObject({ accessStatus: 'NOT_RECEIVED_DISPUTED' });

    await expect(
      owner.taxNotice.create({
        data: {
          ...baseNotice(),
          accessStatus: 'UNCONTESTED',
          accessEvidenceStatus: 'CLAIMED',
          accessEvidenceNote: 'Nicht zuordenbarer Nachweis.',
        },
      }),
    ).rejects.toThrow();
  });

  it('erzwingt bei festgestelltem Zugang dieselbe Tatsachenbasis in beiden Datumsfeldern', async () => {
    const actualAccess = () => ({
      ...baseNotice(),
      dateBasis: 'ACTUAL_ACCESS_DETERMINED' as const,
      receivedAt: new Date('2026-06-03T00:00:00.000Z'),
      accessEvidenceStatus: 'PROFESSIONALLY_DETERMINED' as const,
      accessEvidenceNote: 'Zugangstag anhand der Kanzleidokumentation fachlich festgestellt.',
    });

    await expect(owner.taxNotice.create({ data: actualAccess() })).rejects.toThrow(
      /tax_notice_notification_evidence_check/i,
    );

    await expect(
      owner.taxNotice.create({
        data: {
          ...actualAccess(),
          noticeDate: new Date('2026-06-03T00:00:00.000Z'),
        },
      }),
    ).resolves.toMatchObject({
      noticeDate: new Date('2026-06-03T00:00:00.000Z'),
      receivedAt: new Date('2026-06-03T00:00:00.000Z'),
    });
  });

  it('hält Bescheiddatum und Rechtsfrist als Risikowert strikt getrennt', async () => {
    const notice = await owner.taxNotice.create({
      data: {
        ...baseNotice(),
        ...confirmedHolidayContexts(),
        dateBasis: 'DOCUMENT_DATE_RISK_ONLY',
        deadlineCalculationStatus: 'RISK_ONLY',
        deadlineCalculationVersion: engineVersion,
        internalRiskDeadline: new Date('2026-07-06T00:00:00.000Z'),
        manualReviewRequired: true,
        manualReviewReason: 'DISPATCH_DATE_UNKNOWN, RISK_DATE_ONLY',
      },
    });

    expect(notice.appealDeadline).toBeNull();
    expect(notice.internalRiskDeadline).not.toBeNull();
  });

  it('blockiert §122a-Felder bei einem normalen Postbescheid', async () => {
    await expect(
      owner.taxNotice.create({
        data: {
          ...baseNotice(),
          retrievalIssuedAt: new Date('2026-05-31T00:00:00.000Z'),
        },
      }),
    ).rejects.toThrow();
  });

  it('invalidiert einen Kontrollvorschlag bei jeder fristrelevanten Tatsachenänderung', async () => {
    const notice = await owner.taxNotice.create({
      data: {
        ...baseNotice(),
        ...confirmedHolidayContexts(),
        dateBasis: 'DISPATCH_DATE',
        deliveryEvidenceStatus: 'SUBSTANTIATED',
        legalRemedyInstructionStatus: 'WIRKSAM',
        calculatedNotificationDate: new Date('2026-06-05T00:00:00.000Z'),
        appealDeadline: new Date('2026-07-06T00:00:00.000Z'),
        deadlineCalculationStatus: 'CALCULATED',
        deadlineCalculationVersion: engineVersion,
        manualReviewRequired: false,
      },
    });

    const changed = await owner.taxNotice.update({
      where: { id: notice.id },
      data: {
        recipientLocality: 'Potsdam',
        appealDeadline: new Date('2099-01-01T00:00:00.000Z'),
      },
    });

    expect(changed).toMatchObject({
      deadlineCalculationStatus: 'MANUAL_REVIEW',
      appealDeadline: null,
      calculatedNotificationDate: null,
      internalRiskDeadline: null,
      manualReviewRequired: true,
    });
  });

  it('setzt den §110-Prüfhinweis bei Datenabruf-Invalidierung und entfernt ihn beim Quellenwechsel', async () => {
    const notice = await owner.taxNotice.create({
      data: {
        ...baseNotice(),
        ...confirmedHolidayContexts(),
        noticeDate: new Date('2026-03-10T00:00:00.000Z'),
        dateBasis: 'PROVISION_DATE',
        deliveryMethod: 'DATA_RETRIEVAL',
        deliveryEvidenceStatus: 'PROFESSIONALLY_DETERMINED',
        legalRemedyInstructionStatus: 'WIRKSAM',
        legalRemedyInstructionValid: true,
        retrievalIssuedAt: new Date('2026-03-09T00:00:00.000Z'),
        retrievalConsentStatus: 'CONFIRMED',
        retrievalNotificationStatus: 'SENT',
        retrievalNotificationDate: new Date('2026-03-10T00:00:00.000Z'),
        calculatedNotificationDate: new Date('2026-03-16T00:00:00.000Z'),
        appealDeadline: new Date('2026-04-16T00:00:00.000Z'),
        deadlineCalculationStatus: 'CALCULATED',
        deadlineCalculationVersion: engineVersion,
        manualReviewRequired: false,
      },
    });

    const invalidatedRetrieval = await owner.taxNotice.update({
      where: { id: notice.id },
      data: { authorityLocality: 'Potsdam' },
    });
    expect(invalidatedRetrieval).toMatchObject({
      deadlineCalculationStatus: 'MANUAL_REVIEW',
      retrievalReinstatementReviewRequired: true,
    });

    const changedToPost = await owner.taxNotice.update({
      where: { id: notice.id },
      data: {
        deliveryMethod: 'POST',
        dateBasis: 'DISPATCH_DATE',
        retrievalIssuedAt: null,
        retrievalConsentStatus: 'NOT_APPLICABLE',
        retrievalNotificationStatus: 'NOT_RECORDED',
        retrievalNotificationDate: null,
      },
    });
    expect(changedToPost).toMatchObject({
      deliveryMethod: 'POST',
      deadlineCalculationStatus: 'MANUAL_REVIEW',
      retrievalReinstatementReviewRequired: false,
    });
  });

  it('blockiert direkte Änderungen an persistierten Engine-Ergebnissen', async () => {
    const notice = await owner.taxNotice.create({
      data: {
        ...baseNotice(),
        ...confirmedHolidayContexts(),
        dateBasis: 'DISPATCH_DATE',
        deliveryEvidenceStatus: 'SUBSTANTIATED',
        legalRemedyInstructionStatus: 'WIRKSAM',
        calculatedNotificationDate: new Date('2026-06-05T00:00:00.000Z'),
        appealDeadline: new Date('2026-07-06T00:00:00.000Z'),
        deadlineCalculationStatus: 'CALCULATED',
        deadlineCalculationVersion: engineVersion,
        manualReviewRequired: false,
      },
    });

    await expect(
      owner.taxNotice.update({
        where: { id: notice.id },
        data: { appealDeadline: new Date('2026-06-02T00:00:00.000Z') },
      }),
    ).rejects.toThrow();
    await expect(
      owner.taxNotice.update({
        where: { id: notice.id },
        data: { manualReviewRequired: true },
      }),
    ).rejects.toThrow();
  });

  // Fachkatalog: TAX-NOTICE-APPEAL-001
  it('invalidiert nach Inputänderung und sperrt den unverdrahteten Neubewertungspfad', async () => {
    const notice = await owner.taxNotice.create({
      data: {
        ...baseNotice(),
        ...confirmedHolidayContexts(),
        dateBasis: 'DISPATCH_DATE',
        deliveryEvidenceStatus: 'SUBSTANTIATED',
        legalRemedyInstructionStatus: 'WIRKSAM',
        calculatedNotificationDate: new Date('2026-06-05T00:00:00.000Z'),
        appealDeadline: new Date('2026-07-06T00:00:00.000Z'),
        deadlineCalculationStatus: 'CALCULATED',
        deadlineCalculationVersion: engineVersion,
        manualReviewRequired: false,
      },
    });

    const invalidated = await owner.taxNotice.update({
      where: { id: notice.id },
      data: {
        recipientRegion: 'DE-BB',
        recipientLocality: 'Potsdam',
      },
    });
    expect(invalidated).toMatchObject({
      deadlineCalculationStatus: 'MANUAL_REVIEW',
      calculatedNotificationDate: null,
      appealDeadline: null,
      manualReviewRequired: true,
    });

    await expect(
      owner.taxNotice.update({
        where: { id: notice.id },
        data: {
          calculatedNotificationDate: new Date('2026-06-05T00:00:00.000Z'),
          appealDeadline: new Date('2026-07-06T00:00:00.000Z'),
          deadlineCalculationStatus: 'CALCULATED',
          deadlineCalculationVersion: engineVersion,
          manualReviewRequired: false,
          manualReviewReason: null,
        },
      }),
    ).rejects.toThrow(/authorized engine reassessment/);

    // Ein frei setzbarer Custom-GUC ist für sich kein Autorisierungsnachweis:
    // unter der App-Rolle muss derselbe direkte UPDATE weiterhin scheitern.
    await expect(
      owner.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT set_config('app.current_tenant_id', ${tenantId}, true),
                 set_config('app.current_actor_id', ${staffId}, true),
                 set_config('app.current_actor_type', 'STAFF', true)
        `;
        // Frische isolierte Testdatenbanken erben die produktiven
        // ALTER-DEFAULT-PRIVILEGES nicht aus der ursprünglichen Datenbank.
        // Der transaktionale Grant bildet hier nur den regulären App-Zugriff ab
        // und wird zusammen mit dem erwarteten Fehler zurückgerollt.
        await tx.$executeRawUnsafe('GRANT SELECT, UPDATE ON public."tax_notice" TO taxtronik_app');
        await tx.$executeRawUnsafe('SET LOCAL ROLE taxtronik_app');
        await tx.$queryRaw`
          SELECT set_config(
            'app.tax_notice_deadline_reassessment_id',
            ${notice.id},
            true
          )
        `;
        await tx.$executeRaw`
          UPDATE public."tax_notice"
             SET "calculated_notification_date" = DATE '2026-06-05',
                 "appeal_deadline" = DATE '2026-07-06',
                 "deadline_calculation_status" =
                   'CALCULATED'::public."tax_notice_deadline_calculation_status",
                 "deadline_calculation_version" = ${engineVersion},
                 "manual_review_required" = false,
                 "manual_review_reason" = NULL
           WHERE "id" = ${notice.id}::UUID
        `;
      }),
    ).rejects.toThrow(/authorized engine reassessment/);

    const [privilege] = await owner.$queryRaw<Array<{ allowed: boolean }>>`
      SELECT has_function_privilege(
        'taxtronik_app',
        'app.tax_notice_apply_calculated_reassessment(uuid,timestamp without time zone,date,date,text,boolean,text,boolean)',
        'EXECUTE'
      ) AS "allowed"
    `;
    expect(privilege?.allowed).toBe(false);

    await expect(
      owner.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT set_config('app.current_tenant_id', ${tenantId}, true),
                 set_config('app.current_actor_id', ${staffId}, true),
                 set_config('app.current_actor_type', 'STAFF', true)
        `;
        await tx.$executeRawUnsafe('SET LOCAL ROLE taxtronik_app');
        await tx.$queryRaw`
          SELECT *
            FROM app.tax_notice_apply_calculated_reassessment(
              ${notice.id}::UUID,
              ${invalidated.updatedAt}::TIMESTAMP(3),
              ${new Date('2026-06-05T00:00:00.000Z')}::DATE,
              ${new Date('2026-07-06T00:00:00.000Z')}::DATE,
              ${engineVersion}::TEXT,
              ${false}::BOOLEAN,
              ${null}::TEXT,
              ${false}::BOOLEAN
            )
        `;
      }),
    ).rejects.toThrow(/permission denied.*tax_notice_apply_calculated_reassessment/i);
  });

  it('invalidiert den Kontrollvorschlag bei Änderungen von Empfänger oder Behörde', async () => {
    for (const changedName of [
      { recipientName: 'Andere Empfangsbevollmächtigte' },
      { authorityName: 'Anderes Finanzamt' },
    ]) {
      const notice = await owner.taxNotice.create({
        data: {
          ...baseNotice(),
          ...confirmedHolidayContexts(),
          dateBasis: 'DISPATCH_DATE',
          deliveryEvidenceStatus: 'SUBSTANTIATED',
          legalRemedyInstructionStatus: 'WIRKSAM',
          calculatedNotificationDate: new Date('2026-06-05T00:00:00.000Z'),
          appealDeadline: new Date('2026-07-06T00:00:00.000Z'),
          deadlineCalculationStatus: 'CALCULATED',
          deadlineCalculationVersion: engineVersion,
          manualReviewRequired: false,
        },
      });

      const changed = await owner.taxNotice.update({
        where: { id: notice.id },
        data: changedName,
      });

      expect(changed).toMatchObject({
        deadlineCalculationStatus: 'MANUAL_REVIEW',
        appealDeadline: null,
        calculatedNotificationDate: null,
        internalRiskDeadline: null,
        manualReviewRequired: true,
      });
    }
  });

  it('friert die Tatsachenbasis des migrierten §122a-Legacy-Fallbacks ein', async () => {
    const legacyNotice = await owner.$transaction(async (tx) => {
      // Der Marker kann regulär nur aus dem historischen Migrations-Backfill
      // stammen. Für diesen Regressionstest wird genau ein solcher Altbestand
      // innerhalb der isolierten Transaktion nachgebildet.
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      return tx.taxNotice.create({
        data: {
          ...baseNotice(),
          noticeDate: new Date('2025-06-01T00:00:00.000Z'),
          deliveryMethod: 'DATA_RETRIEVAL',
          dateBasis: 'LEGACY_UNVERIFIED',
          retrievalNotificationLegacyFallback: true,
          retrievedAt: new Date('2025-06-03T00:00:00.000Z'),
          appealDeadline: new Date('2025-07-05T00:00:00.000Z'),
        },
      });
    });

    const annotated = await owner.taxNotice.update({
      where: { id: legacyNotice.id },
      data: { reviewNotes: 'Altbestand zur fachlichen Nacherfassung vorgemerkt.' },
    });
    expect(annotated).toMatchObject({
      retrievedAt: new Date('2025-06-03T00:00:00.000Z'),
      appealDeadline: new Date('2025-07-05T00:00:00.000Z'),
    });

    await expect(
      owner.taxNotice.update({
        where: { id: legacyNotice.id },
        data: { dateBasis: 'PROVISION_DATE' },
      }),
    ).rejects.toThrow();
    await expect(
      owner.taxNotice.update({
        where: { id: legacyNotice.id },
        data: { retrievalIssuedAt: new Date('2025-05-31T00:00:00.000Z') },
      }),
    ).rejects.toThrow();
    await expect(
      owner.taxNotice.update({
        where: { id: legacyNotice.id },
        data: { retrievalNotificationDate: new Date('2025-06-01T00:00:00.000Z') },
      }),
    ).rejects.toThrow();
    await expect(
      owner.taxNotice.update({
        where: { id: legacyNotice.id },
        data: { retrievalNotificationDisputedOrLate: true },
      }),
    ).rejects.toThrow();
    await expect(
      owner.taxNotice.update({
        where: { id: legacyNotice.id },
        data: { retrievedAt: new Date('2025-06-04T00:00:00.000Z') },
      }),
    ).rejects.toThrow();
    await expect(
      owner.taxNotice.update({
        where: { id: legacyNotice.id },
        data: { appealDeadline: new Date('2099-01-01T00:00:00.000Z') },
      }),
    ).rejects.toThrow();
  });

  // Fachkatalog: TAX-NOTICE-APPEAL-001, TAX-CONTROL-STATUS-001
  it('erhält historischen Teilabhilfe-Altbestand ohne erfundene Ereignisdaten', async () => {
    const filing = {
      appealFiledAt: new Date('2026-06-05T00:00:00.000Z'),
      appealFiledBy: staffId,
    };
    const legacyPartialRelief = await owner.$transaction(async (tx) => {
      // Simuliert genau eine vor der Migration vorhandene TEILABHILFE-Zeile:
      // Der neue Insert-Guard war damals noch nicht installiert; sämtliche
      // übrigen Constraints bleiben auch in diesem Test aktiv.
      await tx.$executeRawUnsafe(
        'ALTER TABLE public."tax_notice" DISABLE TRIGGER tax_notice_partial_relief_evidence_guard',
      );
      const notice = await tx.taxNotice.create({
        data: { ...baseNotice(), status: 'TEILABHILFE', ...filing },
      });
      await tx.$executeRawUnsafe(
        'ALTER TABLE public."tax_notice" ENABLE TRIGGER tax_notice_partial_relief_evidence_guard',
      );
      return notice;
    });

    await expect(
      owner.taxNotice.update({
        where: { id: legacyPartialRelief.id },
        data: { period: `${legacyPartialRelief.period}-aktennotiz` },
      }),
    ).resolves.toMatchObject({
      status: 'TEILABHILFE',
      partialReliefReceivedAt: null,
      partialReliefReceivedBy: null,
    });

    await expect(
      owner.taxNotice.update({
        where: { id: legacyPartialRelief.id },
        data: {
          status: 'ABGEHOLFEN',
          appealResolvedAt: new Date('2026-06-15T00:00:00.000Z'),
        },
      }),
    ).rejects.toThrow(/partial relief receipt evidence must be completed/i);

    await expect(
      owner.taxNotice.update({
        where: { id: legacyPartialRelief.id },
        data: {
          status: 'ABGEHOLFEN',
          partialReliefReceivedAt: new Date('2026-06-10T00:00:00.000Z'),
          partialReliefReceivedBy: staffId,
          appealResolvedAt: new Date('2026-06-15T00:00:00.000Z'),
        },
      }),
    ).resolves.toMatchObject({
      status: 'ABGEHOLFEN',
      partialReliefReceivedAt: new Date('2026-06-10T00:00:00.000Z'),
      partialReliefReceivedBy: staffId,
    });
  });

  // Fachkatalog: TAX-NOTICE-APPEAL-001, TAX-CONTROL-STATUS-001
  it('verlangt und erhält den eigenen Ereignisnachweis einer Teilabhilfe', async () => {
    const filing = {
      appealFiledAt: new Date('2026-06-05T00:00:00.000Z'),
      appealFiledBy: staffId,
    };
    await expect(
      owner.taxNotice.create({
        data: { ...baseNotice(), status: 'TEILABHILFE', ...filing },
      }),
    ).rejects.toThrow();

    await expect(
      owner.taxNotice.create({
        data: {
          ...baseNotice(),
          status: 'EINSPRUCH',
          ...filing,
          partialReliefReceivedAt: new Date('2026-06-10T00:00:00.000Z'),
        },
      }),
    ).rejects.toThrow();

    await expect(
      owner.taxNotice.create({
        data: {
          ...baseNotice(),
          status: 'TEILABHILFE',
          ...filing,
          partialReliefReceivedAt: new Date('2026-06-04T00:00:00.000Z'),
          partialReliefReceivedBy: staffId,
        },
      }),
    ).rejects.toThrow();

    const partialRelief = await owner.taxNotice.create({
      data: {
        ...baseNotice(),
        status: 'TEILABHILFE',
        ...filing,
        partialReliefReceivedAt: new Date('2026-06-10T00:00:00.000Z'),
        partialReliefReceivedBy: staffId,
      },
    });
    expect(partialRelief).toMatchObject({
      status: 'TEILABHILFE',
      partialReliefReceivedAt: new Date('2026-06-10T00:00:00.000Z'),
      partialReliefReceivedBy: staffId,
      klageDeadline: null,
    });

    await expect(
      owner.taxNotice.update({
        where: { id: partialRelief.id },
        data: {
          status: 'ABGEHOLFEN',
          appealResolvedAt: new Date('2026-06-09T00:00:00.000Z'),
        },
      }),
    ).rejects.toThrow();

    const resolved = await owner.taxNotice.update({
      where: { id: partialRelief.id },
      data: {
        status: 'ABGEHOLFEN',
        appealResolvedAt: new Date('2026-06-15T00:00:00.000Z'),
      },
    });
    expect(resolved).toMatchObject({
      status: 'ABGEHOLFEN',
      partialReliefReceivedAt: new Date('2026-06-10T00:00:00.000Z'),
      partialReliefReceivedBy: staffId,
    });

    await expect(
      owner.taxNotice.update({
        where: { id: partialRelief.id },
        data: { partialReliefReceivedAt: null, partialReliefReceivedBy: null },
      }),
    ).rejects.toThrow(/partial relief receipt evidence is immutable/i);
  });

  it('trennt Teilabhilfe und Teil-Einspruchsentscheidung auf Datenbankebene', async () => {
    const filing = {
      appealFiledAt: new Date('2026-06-05T00:00:00.000Z'),
      appealFiledBy: staffId,
    };
    await expect(
      owner.taxNotice.create({
        data: {
          ...baseNotice(),
          status: 'TEILEINSPRUCHSENTSCHEIDUNG',
          ...filing,
          appealDecisionReceivedAt: new Date('2026-06-10T00:00:00.000Z'),
          appealDecisionLegalRemedyInstructionValid: true,
          klageDeadline: new Date('2026-07-10T00:00:00.000Z'),
        },
      }),
    ).resolves.toMatchObject({ status: 'TEILEINSPRUCHSENTSCHEIDUNG' });
  });

  // Fachkatalog: TAX-CONTROL-STATUS-001, TAX-NOTICE-APPEAL-001
  it('blockiert Bestandskraft ohne belastbaren Fristablauf', async () => {
    await expect(
      owner.taxNotice.create({
        data: {
          ...baseNotice(),
          status: 'BESTANDSKRAEFTIG',
          legalFinalAt: new Date('2026-06-10T00:00:00.000Z'),
          legalFinalBy: staffId,
          legalFinalReason: 'Fristablauf und Aktenlage fachlich geprüft.',
        },
      }),
    ).rejects.toThrow();
  });

  it('erlaubt Bestandskraft ohne Einspruch erst am Folgetag der geprüften Frist', async () => {
    const reviewedNotice = await owner.taxNotice.create({
      data: {
        ...baseNotice(),
        ...confirmedHolidayContexts(),
        status: 'GEPRUEFT',
        reviewedAt: new Date('2026-06-02T08:00:00.000Z'),
        reviewedBy: staffId,
        dateBasis: 'DISPATCH_DATE',
        deliveryEvidenceStatus: 'SUBSTANTIATED',
        legalRemedyInstructionStatus: 'WIRKSAM',
        calculatedNotificationDate: new Date('2026-06-05T00:00:00.000Z'),
        appealDeadline: new Date('2026-07-06T00:00:00.000Z'),
        deadlineCalculationStatus: 'CALCULATED',
        deadlineCalculationVersion: engineVersion,
        manualReviewRequired: false,
      },
    });

    await expect(
      owner.taxNotice.update({
        where: { id: reviewedNotice.id },
        data: {
          status: 'BESTANDSKRAEFTIG',
          legalFinalAt: new Date('2026-07-06T12:00:00.000Z'),
          legalFinalBy: staffId,
          legalFinalReason: 'Einspruchsfrist und Aktenlage fachlich geprüft.',
        },
      }),
    ).rejects.toThrow();

    await expect(
      owner.taxNotice.update({
        where: { id: reviewedNotice.id },
        data: {
          status: 'BESTANDSKRAEFTIG',
          legalFinalAt: new Date('2026-07-07T08:00:00.000Z'),
          legalFinalBy: staffId,
          legalFinalReason: 'Einspruchsfrist und Aktenlage fachlich geprüft.',
        },
      }),
    ).resolves.toMatchObject({ status: 'BESTANDSKRAEFTIG' });
  });

  it('erlaubt Bestandskraft nach Zurückweisung erst am Folgetag der Klagefrist', async () => {
    const rejectedNotice = await owner.taxNotice.create({
      data: {
        ...baseNotice(),
        status: 'ZURUECKGEWIESEN',
        appealFiledAt: new Date('2026-06-05T08:00:00.000Z'),
        appealFiledBy: staffId,
        appealResolvedAt: new Date('2026-06-10T08:00:00.000Z'),
        appealDecisionReceivedAt: new Date('2026-06-10T00:00:00.000Z'),
        appealDecisionLegalRemedyInstructionValid: true,
        klageDeadline: new Date('2026-07-10T00:00:00.000Z'),
      },
    });

    await expect(
      owner.taxNotice.update({
        where: { id: rejectedNotice.id },
        data: {
          status: 'BESTANDSKRAEFTIG',
          legalFinalAt: new Date('2026-07-10T12:00:00.000Z'),
          legalFinalBy: staffId,
          legalFinalReason: 'Klagefrist und Aktenlage fachlich geprüft.',
        },
      }),
    ).rejects.toThrow();

    await expect(
      owner.taxNotice.update({
        where: { id: rejectedNotice.id },
        data: {
          status: 'BESTANDSKRAEFTIG',
          klageDeadline: new Date('2026-06-30T00:00:00.000Z'),
          legalFinalAt: new Date('2026-07-01T08:00:00.000Z'),
          legalFinalBy: staffId,
          legalFinalReason: 'Klagefrist und Aktenlage fachlich geprüft.',
        },
      }),
    ).rejects.toThrow();

    await expect(
      owner.taxNotice.update({
        where: { id: rejectedNotice.id },
        data: {
          status: 'BESTANDSKRAEFTIG',
          legalFinalAt: new Date('2026-07-11T08:00:00.000Z'),
          legalFinalBy: staffId,
          legalFinalReason: 'Klagefrist und Aktenlage fachlich geprüft.',
        },
      }),
    ).resolves.toMatchObject({ status: 'BESTANDSKRAEFTIG' });
  });

  it('bewahrt bei frühem Zugang die Fiktionsfrist und blockiert widersprüchliche Einordnung', async () => {
    const earlierAccess = {
      ...baseNotice(),
      ...confirmedHolidayContexts(),
      dateBasis: 'DISPATCH_DATE' as const,
      deliveryEvidenceStatus: 'SUBSTANTIATED' as const,
      legalRemedyInstructionStatus: 'WIRKSAM' as const,
      accessStatus: 'EARLIER_RECEIPT_RECORDED' as const,
      receivedAt: new Date('2026-06-03T00:00:00.000Z'),
      accessEvidenceStatus: 'SUBSTANTIATED' as const,
      accessEvidenceNote: 'Dokumentierter früherer Posteingang.',
      calculatedNotificationDate: new Date('2026-06-05T00:00:00.000Z'),
      appealDeadline: new Date('2026-07-06T00:00:00.000Z'),
      deadlineCalculationStatus: 'CALCULATED' as const,
      deadlineCalculationVersion: engineVersion,
      manualReviewRequired: false,
    };

    await expect(owner.taxNotice.create({ data: earlierAccess })).resolves.toMatchObject({
      calculatedNotificationDate: new Date('2026-06-05T00:00:00.000Z'),
    });

    await expect(
      owner.taxNotice.create({
        data: {
          ...earlierAccess,
          ...baseNotice(),
          receivedAt: new Date('2026-06-09T00:00:00.000Z'),
        },
      }),
    ).rejects.toThrow();
  });

  it('persistiert beide Szenarien bei einem substantiiert behaupteten späteren Zugang', async () => {
    const notice = await owner.taxNotice.create({
      data: {
        ...baseNotice(),
        ...confirmedHolidayContexts(),
        dateBasis: 'DISPATCH_DATE',
        deliveryEvidenceStatus: 'SUBSTANTIATED',
        legalRemedyInstructionStatus: 'WIRKSAM',
        accessStatus: 'LATER_RECEIPT_CLAIMED',
        receivedAt: new Date('2026-06-09T00:00:00.000Z'),
        accessEvidenceStatus: 'SUBSTANTIATED',
        accessEvidenceNote: 'Umschlag und Posteingangsdokumentation liegen vor.',
        internalRiskDeadline: new Date('2026-07-06T00:00:00.000Z'),
        alternativeClaimedAccessDeadline: new Date('2026-07-09T00:00:00.000Z'),
        deadlineCalculationStatus: 'MANUAL_REVIEW',
        deadlineCalculationVersion: engineVersion,
        manualReviewRequired: true,
        manualReviewReason: 'LATER_ACCESS_REQUIRES_EVIDENCE_REVIEW',
      },
    });

    expect(notice).toMatchObject({
      appealDeadline: null,
      deadlineCalculationStatus: 'MANUAL_REVIEW',
      alternativeClaimedAccessDeadline: new Date('2026-07-09T00:00:00.000Z'),
    });

    await expect(
      owner.taxNotice.create({
        data: {
          ...baseNotice(),
          ...confirmedHolidayContexts(),
          dateBasis: 'DISPATCH_DATE',
          deliveryEvidenceStatus: 'SUBSTANTIATED',
          legalRemedyInstructionStatus: 'WIRKSAM',
          accessStatus: 'LATER_RECEIPT_CLAIMED',
          receivedAt: new Date('2026-06-09T00:00:00.000Z'),
          accessEvidenceStatus: 'SUBSTANTIATED',
          accessEvidenceNote: 'Umschlag und Posteingangsdokumentation liegen vor.',
          alternativeClaimedAccessDeadline: new Date('2026-07-09T00:00:00.000Z'),
          deadlineCalculationStatus: 'MANUAL_REVIEW',
          deadlineCalculationVersion: engineVersion,
          manualReviewRequired: true,
          manualReviewReason: 'LATER_ACCESS_REQUIRES_EVIDENCE_REVIEW',
        },
      }),
    ).rejects.toThrow();

    await expect(
      owner.taxNotice.create({
        data: {
          ...baseNotice(),
          ...confirmedHolidayContexts(),
          dateBasis: 'DISPATCH_DATE',
          deliveryEvidenceStatus: 'SUBSTANTIATED',
          legalRemedyInstructionStatus: 'WIRKSAM',
          accessStatus: 'LATER_RECEIPT_CLAIMED',
          receivedAt: new Date('2026-06-09T00:00:00.000Z'),
          accessEvidenceStatus: 'SUBSTANTIATED',
          accessEvidenceNote: 'Umschlag und Posteingangsdokumentation liegen vor.',
          internalRiskDeadline: new Date('2026-07-10T00:00:00.000Z'),
          alternativeClaimedAccessDeadline: new Date('2026-07-09T00:00:00.000Z'),
          deadlineCalculationStatus: 'MANUAL_REVIEW',
          deadlineCalculationVersion: engineVersion,
          manualReviewRequired: true,
          manualReviewReason: 'LATER_ACCESS_REQUIRES_EVIDENCE_REVIEW',
        },
      }),
    ).rejects.toThrow();
  });

  it('erlaubt ab 2027 einen erst nach Bereitstellung zugegangenen Postantrag', async () => {
    await expect(
      owner.taxNotice.create({
        data: {
          ...baseNotice(),
          ...confirmedHolidayContexts(),
          noticeDate: new Date('2027-02-01T00:00:00.000Z'),
          dateBasis: 'PROVISION_DATE',
          deliveryMethod: 'DATA_RETRIEVAL',
          deliveryEvidenceStatus: 'PROFESSIONALLY_DETERMINED',
          legalRemedyInstructionStatus: 'WIRKSAM',
          retrievalIssuedAt: new Date('2027-01-31T00:00:00.000Z'),
          retrievalEligibility2027Status: 'CONFIRMED',
          retrievalPostalRequestStatus: 'EFFECTIVE',
          retrievalPostalRequestReceivedAt: new Date('2027-02-02T00:00:00.000Z'),
          retrievalNotificationStatus: 'SENT',
          retrievalNotificationDate: new Date('2027-02-01T00:00:00.000Z'),
          calculatedNotificationDate: new Date('2027-02-05T00:00:00.000Z'),
          appealDeadline: new Date('2027-03-05T00:00:00.000Z'),
          deadlineCalculationStatus: 'CALCULATED',
          deadlineCalculationVersion: engineVersion,
          manualReviewRequired: false,
        },
      }),
    ).resolves.toMatchObject({ deadlineCalculationStatus: 'CALCULATED' });
  });

  it('hält einen rechtzeitigen oder zeitlich ungeklärten Postantrag als §110-Prüffall offen', async () => {
    const blockedPostalRequest = () => ({
      ...baseNotice(),
      ...confirmedHolidayContexts(),
      noticeDate: new Date('2027-02-01T00:00:00.000Z'),
      dateBasis: 'PROVISION_DATE' as const,
      deliveryMethod: 'DATA_RETRIEVAL',
      deliveryEvidenceStatus: 'PROFESSIONALLY_DETERMINED' as const,
      legalRemedyInstructionStatus: 'WIRKSAM' as const,
      retrievalIssuedAt: new Date('2027-01-31T00:00:00.000Z'),
      retrievalEligibility2027Status: 'CONFIRMED' as const,
      retrievalPostalRequestStatus: 'EFFECTIVE' as const,
      retrievalNotificationStatus: 'SENT' as const,
      retrievalNotificationDate: new Date('2027-02-01T00:00:00.000Z'),
      internalRiskDeadline: new Date('2027-03-05T00:00:00.000Z'),
      deadlineCalculationStatus: 'MANUAL_REVIEW' as const,
      deadlineCalculationVersion: engineVersion,
      manualReviewRequired: true,
      manualReviewReason: 'POSTAL_REQUEST_EFFECTIVE_REQUIRES_REVIEW',
    });

    await expect(owner.taxNotice.create({ data: blockedPostalRequest() })).rejects.toThrow();

    await expect(
      owner.taxNotice.create({
        data: {
          ...blockedPostalRequest(),
          retrievalReinstatementReviewRequired: true,
        },
      }),
    ).resolves.toMatchObject({
      deadlineCalculationStatus: 'MANUAL_REVIEW',
      retrievalReinstatementReviewRequired: true,
      retrievalPostalRequestReceivedAt: null,
    });

    await expect(
      owner.taxNotice.create({
        data: {
          ...blockedPostalRequest(),
          retrievalPostalRequestReceivedAt: new Date('2027-02-01T00:00:00.000Z'),
          retrievalReinstatementReviewRequired: true,
        },
      }),
    ).resolves.toMatchObject({
      deadlineCalculationStatus: 'MANUAL_REVIEW',
      retrievalReinstatementReviewRequired: true,
    });
  });
});
