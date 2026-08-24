'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { berlinCalendarDate } from '@taxtronik/tax';
import { evidenceService } from '@/server/container';
import { assertClientInTenant } from '@/server/db/assert-tenant';
import { assertClientAccessTx, isStaffAdmin, toActionError } from '@/server/auth/rbac';
import { staffActionGuard, type ActionResult } from '@/server/actions/staff-action';
import { planNoticeTransition } from './notice-transition';
import {
  assessNoticeEvidence,
  determinedAccessDateIsConsistent,
  holidayContext,
  NOTICE_DEADLINE_CALCULATION_VERSION,
  type EvidenceStatus,
  type HolidayContextStatus,
} from './notice-assessment';
import { validateDataRetrievalEvidence } from './data-retrieval';
import {
  taxNoticeCreateAudit,
  taxNoticeStatusAfterAudit,
  taxNoticeStatusBeforeAudit,
} from './notice-audit';

const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const YmdSchema = z
  .string()
  .regex(YMD_PATTERN)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'Ungültiges Kalenderdatum.');

const KIND_VALUES = [
  'USTA',
  'UST_JAHR',
  'EST',
  'KST',
  'GEWST_MESSBESCHEID',
  'GEWST',
  'LSTA',
  'FESTSTELLUNG',
  'ZERLEGUNG',
  'SONSTIGE',
] as const;
const DELIVERY_METHODS = [
  'POST',
  'POST_ABROAD',
  'ELECTRONIC',
  'DATA_RETRIEVAL',
  'FORMAL',
  'PERSONAL',
  'OTHER',
] as const;
const DATE_BASIS_VALUES = [
  'DISPATCH_DATE',
  'PROVISION_DATE',
  'ACTUAL_ACCESS_DETERMINED',
  'DOCUMENT_DATE_RISK_ONLY',
] as const;
const EVIDENCE_STATUS_VALUES = ['CLAIMED', 'SUBSTANTIATED', 'PROFESSIONALLY_DETERMINED'] as const;
const ACCESS_STATUS_VALUES = [
  'UNCONTESTED',
  'NOT_RECEIVED_DISPUTED',
  'EARLIER_RECEIPT_RECORDED',
  'LATER_RECEIPT_CLAIMED',
  'LATER_RECEIPT_DETERMINED',
] as const;
const INSTRUCTION_STATUS_VALUES = ['WIRKSAM', 'UNWIRKSAM', 'UNKLAR'] as const;
const HOLIDAY_CONTEXT_VALUES = [
  'CONFIRMED_FOR_DATE_AND_LOCATION',
  'STATE_LEVEL_ONLY',
  'HISTORICAL_UNVERIFIED',
  'FOREIGN_UNSUPPORTED',
  'UNKNOWN',
] as const;
const REGION_VALUES = [
  'DE-BW',
  'DE-BY',
  'DE-BE',
  'DE-BB',
  'DE-HB',
  'DE-HH',
  'DE-HE',
  'DE-MV',
  'DE-NI',
  'DE-NW',
  'DE-RP',
  'DE-SL',
  'DE-SN',
  'DE-ST',
  'DE-SH',
  'DE-TH',
] as const;
const OptionalYmdSchema = z.union([YmdSchema, z.literal('')]).optional();
const OptionalRegionSchema = z.union([z.enum(REGION_VALUES), z.literal('')]);
const OptionalEvidenceSchema = z.union([z.enum(EVIDENCE_STATUS_VALUES), z.literal('')]);
const OptionalBavariaSchema = z.enum(['YES', 'NO', 'UNKNOWN']);
const CountryCodeSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
  z.string().regex(/^[A-Z]{2}$/),
);

const Schema = z.object({
  clientId: z.string().uuid(),
  kind: z.enum(KIND_VALUES),
  period: z.string().min(1).max(20),
  noticeDate: YmdSchema,
  dateBasis: z.enum(DATE_BASIS_VALUES),
  deliveryMethod: z.enum(DELIVERY_METHODS),
  deliveryEvidenceStatus: z.enum(EVIDENCE_STATUS_VALUES),
  deliveryEvidenceNote: z.string().max(2_000).optional(),
  legalRemedyInstruction: z.enum(INSTRUCTION_STATUS_VALUES),
  legalRemedyInstructionNote: z.string().min(3).max(2_000),
  receivedAt: OptionalYmdSchema,
  accessStatus: z.enum(ACCESS_STATUS_VALUES),
  accessEvidenceStatus: OptionalEvidenceSchema,
  accessEvidenceNote: z.string().max(2_000).optional(),
  recipientName: z.string().min(1).max(200),
  recipientCountryCode: CountryCodeSchema,
  recipientRegion: OptionalRegionSchema,
  recipientLocality: z.string().max(200).optional(),
  recipientLocalHolidayDates: z.string().max(1_000).optional(),
  recipientHolidayContextStatus: z.enum(HOLIDAY_CONTEXT_VALUES),
  recipientBavariaAssumption: OptionalBavariaSchema,
  authorityName: z.string().min(1).max(200),
  authorityCountryCode: CountryCodeSchema,
  authorityRegion: OptionalRegionSchema,
  authorityLocality: z.string().max(200).optional(),
  authorityLocalHolidayDates: z.string().max(1_000).optional(),
  authorityHolidayContextStatus: z.enum(HOLIDAY_CONTEXT_VALUES),
  authorityBavariaAssumption: OptionalBavariaSchema,
  holidayContextNote: z.string().max(2_000).optional(),
  retrievalIssuedAt: OptionalYmdSchema,
  retrievalNotificationDate: OptionalYmdSchema,
  retrievalNotificationDisputedOrLate: z.boolean(),
  retrievedAt: OptionalYmdSchema,
  retrievalConsentStatus: z.enum(['NOT_APPLICABLE', 'CONFIRMED', 'NOT_GIVEN', 'UNKNOWN']),
  retrievalEligibility2027Status: z.enum(['NOT_APPLICABLE', 'CONFIRMED', 'NOT_MET', 'UNKNOWN']),
  retrievalPostalRequestStatus: z.enum([
    'NOT_APPLICABLE',
    'NONE_EFFECTIVE',
    'EFFECTIVE',
    'UNKNOWN',
  ]),
  retrievalPostalRequestReceivedAt: OptionalYmdSchema,
  retrievalNotificationStatus: z.enum(['NOT_RECORDED', 'SENT', 'FAILED', 'UNKNOWN']),
  fileNumber: z.string().max(100).optional().nullable(),
  assessedAmount: z.string().optional().nullable(),
  expectedAmount: z.string().optional().nullable(),
  prepaidAmount: z.string().optional().nullable(),
  payAmount: z.string().optional().nullable(),
  reviewNotes: z.string().max(10_000).optional().nullable(),
});

type CreateNoticeInput = z.infer<typeof Schema>;

interface PreparedCreateNotice {
  data: CreateNoticeInput;
  noticeDate: Date;
  receivedAt: Date | null;
  retrievalIssuedAt: Date | null;
  retrievalNotificationDate: Date | null;
  retrievedAt: Date | null;
  retrievalPostalRequestReceivedAt: Date | null;
  recipientLocalHolidayDates: Date[];
  authorityLocalHolidayDates: Date[];
  assessment: ReturnType<typeof assessNoticeEvidence>;
  legalRemedyInstructionValid: boolean;
}

function parseDecimal(s: string | null | undefined): string | undefined {
  if (s === null || s === undefined || s.trim() === '') return undefined;
  const n = Number(s.replace(',', '.'));
  if (!Number.isFinite(n)) return undefined;
  return n.toFixed(2);
}

function trimmedOrNull(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function valueOrNull<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

function emptyStringOrNull<T extends string>(value: T | null | undefined): Exclude<T, ''> | null {
  return (value || null) as Exclude<T, ''> | null;
}

function joinedReasonsOrNull(reasons: readonly string[]): string | null {
  return reasons.length > 0 ? reasons.join(', ') : null;
}

function optionalYmdToDate(value: string | null | undefined): Date | null {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

function localHolidayDates(value: string | null | undefined, label: string): Date[] {
  if (!value?.trim()) return [];
  const values = value
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unique = [...new Set(values)];
  for (const entry of unique) {
    const parsed = YmdSchema.safeParse(entry);
    if (!parsed.success) {
      throw new Error(`${label}: „${entry}“ ist kein gültiges Datum im Format JJJJ-MM-TT.`);
    }
  }
  return unique.map((entry) => new Date(`${entry}T00:00:00.000Z`));
}

function parseCreateNoticeInput(formData: FormData): CreateNoticeInput {
  const parsed = Schema.safeParse({
    clientId: formData.get('clientId'),
    kind: formData.get('kind'),
    period: formData.get('period'),
    noticeDate: formData.get('noticeDate'),
    dateBasis: formData.get('dateBasis'),
    deliveryMethod: formData.get('deliveryMethod'),
    deliveryEvidenceStatus: formData.get('deliveryEvidenceStatus'),
    deliveryEvidenceNote: formData.get('deliveryEvidenceNote'),
    legalRemedyInstruction: formData.get('legalRemedyInstruction'),
    legalRemedyInstructionNote: formData.get('legalRemedyInstructionNote'),
    receivedAt: formData.get('receivedAt'),
    accessStatus: formData.get('accessStatus'),
    accessEvidenceStatus: formData.get('accessEvidenceStatus'),
    accessEvidenceNote: formData.get('accessEvidenceNote'),
    recipientName: formData.get('recipientName'),
    recipientCountryCode: formData.get('recipientCountryCode'),
    recipientRegion: formData.get('recipientRegion'),
    recipientLocality: formData.get('recipientLocality'),
    recipientLocalHolidayDates: formData.get('recipientLocalHolidayDates'),
    recipientHolidayContextStatus: formData.get('recipientHolidayContextStatus'),
    recipientBavariaAssumption: formData.get('recipientBavariaAssumption'),
    authorityName: formData.get('authorityName'),
    authorityCountryCode: formData.get('authorityCountryCode'),
    authorityRegion: formData.get('authorityRegion'),
    authorityLocality: formData.get('authorityLocality'),
    authorityLocalHolidayDates: formData.get('authorityLocalHolidayDates'),
    authorityHolidayContextStatus: formData.get('authorityHolidayContextStatus'),
    authorityBavariaAssumption: formData.get('authorityBavariaAssumption'),
    holidayContextNote: formData.get('holidayContextNote'),
    retrievalIssuedAt: formData.get('retrievalIssuedAt'),
    retrievalNotificationDate: formData.get('retrievalNotificationDate'),
    retrievalNotificationDisputedOrLate:
      formData.get('retrievalNotificationDisputedOrLate') === 'on',
    retrievedAt: formData.get('retrievedAt'),
    retrievalConsentStatus: formData.get('retrievalConsentStatus'),
    retrievalEligibility2027Status: formData.get('retrievalEligibility2027Status'),
    retrievalPostalRequestStatus: formData.get('retrievalPostalRequestStatus'),
    retrievalPostalRequestReceivedAt: formData.get('retrievalPostalRequestReceivedAt'),
    retrievalNotificationStatus: formData.get('retrievalNotificationStatus'),
    fileNumber: formData.get('fileNumber'),
    assessedAmount: formData.get('assessedAmount'),
    expectedAmount: formData.get('expectedAmount'),
    prepaidAmount: formData.get('prepaidAmount'),
    payAmount: formData.get('payAmount'),
    reviewNotes: formData.get('reviewNotes'),
  });
  if (!parsed.success) {
    throw new Error(
      'Validierungsfehler: ' + parsed.error.issues.map((issue) => issue.message).join('; '),
    );
  }
  return parsed.data;
}

function validateDeliveryDatesAndEvidence(
  data: CreateNoticeInput,
  noticeDate: Date,
  receivedAt: Date | null,
  today: Date,
): void {
  if (noticeDate > today) {
    throw new Error('Ausgangsdatum darf nicht in der Zukunft liegen.');
  }
  if (receivedAt && receivedAt > today) {
    throw new Error('Bekanntgabe-/Zugangstag darf nicht in der Zukunft liegen.');
  }
  if (receivedAt && receivedAt.getTime() < noticeDate.getTime()) {
    throw new Error('Zugangsdatum darf nicht vor dem Bescheid-/Ausgangsdatum liegen.');
  }
  if (!determinedAccessDateIsConsistent({ dateBasis: data.dateBasis, noticeDate, receivedAt })) {
    throw new Error(
      'Beim fachlich festgestellten Bekanntgabetag müssen Ausgangs- und Zugangstag übereinstimmen.',
    );
  }
  if (
    data.deliveryEvidenceStatus !== 'CLAIMED' &&
    (data.deliveryEvidenceNote?.trim().length ?? 0) < 3
  ) {
    throw new Error('Der Nachweis des Ausgangsdatums muss kurz beschrieben werden.');
  }
  if (data.accessEvidenceStatus && (data.accessEvidenceNote?.trim().length ?? 0) < 3) {
    throw new Error('Der Zugangsnachweis muss kurz beschrieben werden.');
  }
  if (data.accessStatus !== 'UNCONTESTED' && !data.accessEvidenceStatus) {
    throw new Error(
      'Nichtzugang oder eine Zugangsabweichung benötigt einen dokumentierten Nachweisstatus.',
    );
  }
  if (
    data.accessStatus === 'UNCONTESTED' &&
    data.dateBasis !== 'ACTUAL_ACCESS_DETERMINED' &&
    data.accessEvidenceStatus
  ) {
    throw new Error(
      'Ein Zugangsnachweis darf nur zu einer dokumentierten Abweichung oder einem festgestellten Zugangstag gespeichert werden.',
    );
  }
}

function validateSpecialDeliveryMethodEvidence(
  data: CreateNoticeInput,
  receivedAt: Date | null,
): void {
  if (
    ['FORMAL', 'PERSONAL', 'OTHER'].includes(data.deliveryMethod) &&
    data.dateBasis !== 'ACTUAL_ACCESS_DETERMINED'
  ) {
    throw new Error('Dieser Bekanntgabeweg benötigt einen fachlich festgestellten Zugangstag.');
  }
  if (
    ['FORMAL', 'PERSONAL', 'OTHER'].includes(data.deliveryMethod) &&
    (!receivedAt || data.accessEvidenceStatus !== 'PROFESSIONALLY_DETERMINED')
  ) {
    throw new Error(
      'Der Bekanntgabetag muss mit fachlich festgestelltem Zugangsnachweis dokumentiert werden.',
    );
  }
  if (data.deliveryMethod === 'DATA_RETRIEVAL' && receivedAt) {
    throw new Error(
      'Beim Datenabruf ist das allgemeine Zugangsdatum nicht anwendbar; verwenden Sie gegebenenfalls den tatsächlichen Abruftag.',
    );
  }
  if (
    data.deliveryMethod === 'DATA_RETRIEVAL' &&
    (data.accessStatus !== 'UNCONTESTED' ||
      data.accessEvidenceStatus !== undefined ||
      Boolean(data.accessEvidenceNote?.trim()))
  ) {
    throw new Error(
      'Beim Datenabruf sind allgemeine Zugangseinwendungen nicht anwendbar; verwenden Sie die getrennten §-122a-Felder für Benachrichtigung und Abruf.',
    );
  }
  if (data.deliveryMethod === 'DATA_RETRIEVAL' && data.dateBasis !== 'PROVISION_DATE') {
    throw new Error('Beim Datenabruf muss das Ausgangsdatum die Bereitstellung bezeichnen.');
  }
  if (data.deliveryMethod !== 'DATA_RETRIEVAL' && data.dateBasis === 'PROVISION_DATE') {
    throw new Error('Bereitstellung ist nur beim Bekanntgabeweg Datenabruf zulässig.');
  }
}

function validateAccessDeviationEvidence(data: CreateNoticeInput, receivedAt: Date | null): void {
  if (data.accessStatus === 'NOT_RECEIVED_DISPUTED' && receivedAt) {
    throw new Error('Bei vollständig bestrittenem Zugang darf kein Zugangstag festgelegt werden.');
  }
  if (
    data.accessStatus === 'UNCONTESTED' &&
    receivedAt &&
    data.dateBasis !== 'ACTUAL_ACCESS_DETERMINED'
  ) {
    throw new Error(
      'Ein erfasster Zugangstag muss als früherer/späterer Zugang eingeordnet oder als fachlich festgestellter Bekanntgabetag verwendet werden.',
    );
  }
  if (
    ['EARLIER_RECEIPT_RECORDED', 'LATER_RECEIPT_CLAIMED', 'LATER_RECEIPT_DETERMINED'].includes(
      data.accessStatus,
    ) &&
    !receivedAt
  ) {
    throw new Error('Für die dokumentierte Zugangsabweichung ist ein Zugangstag erforderlich.');
  }
  if (
    data.accessStatus === 'LATER_RECEIPT_DETERMINED' &&
    data.accessEvidenceStatus !== 'PROFESSIONALLY_DETERMINED'
  ) {
    throw new Error('Ein festgestellter späterer Zugang benötigt die fachliche Feststellung.');
  }
  if (
    ['EARLIER_RECEIPT_RECORDED', 'LATER_RECEIPT_CLAIMED', 'LATER_RECEIPT_DETERMINED'].includes(
      data.accessStatus,
    ) &&
    data.dateBasis !== 'DISPATCH_DATE'
  ) {
    throw new Error(
      'Eine Zugangsabweichung zur gesetzlichen Fiktion benötigt den nachgewiesenen Aufgabe-/Übermittlungstag als Ausgangsbasis.',
    );
  }
}

function validateDeterminedAccessEvidence(data: CreateNoticeInput, receivedAt: Date | null): void {
  if (
    data.dateBasis === 'ACTUAL_ACCESS_DETERMINED' &&
    (!receivedAt || data.accessEvidenceStatus !== 'PROFESSIONALLY_DETERMINED')
  ) {
    throw new Error(
      'Der festgestellte Bekanntgabetag benötigt Zugangstag und fachliche Feststellung.',
    );
  }
  if (
    data.dateBasis === 'ACTUAL_ACCESS_DETERMINED' &&
    data.deliveryEvidenceStatus !== 'PROFESSIONALLY_DETERMINED'
  ) {
    throw new Error(
      'Der als Ausgangsdatum verwendete tatsächliche Zugang muss fachlich festgestellt sein.',
    );
  }
  if (data.dateBasis === 'ACTUAL_ACCESS_DETERMINED' && data.accessStatus !== 'UNCONTESTED') {
    throw new Error(
      'Beim bereits fachlich festgestellten Bekanntgabetag darf keine zusätzliche Fiktionsabweichung ausgewählt sein.',
    );
  }
}

function validateGeneralDeliveryEvidence(
  data: CreateNoticeInput,
  noticeDate: Date,
  receivedAt: Date | null,
  today: Date,
): void {
  validateDeliveryDatesAndEvidence(data, noticeDate, receivedAt, today);
  validateSpecialDeliveryMethodEvidence(data, receivedAt);
  validateAccessDeviationEvidence(data, receivedAt);
  validateDeterminedAccessEvidence(data, receivedAt);
}

function validateHolidayContext(
  label: string,
  countryCode: string,
  region: string,
  locality: string | undefined,
  status: HolidayContextStatus,
  bavariaAssumption: string,
  note: string | undefined,
): void {
  if (status === 'CONFIRMED_FOR_DATE_AND_LOCATION') {
    if (countryCode !== 'DE') {
      throw new Error(
        label + ': Ausländische Feiertagskalender werden nicht automatisch berechnet.',
      );
    }
    if (!region) throw new Error(label + ': Bundesland ist für die Berechnung erforderlich.');
    if ((locality?.trim().length ?? 0) < 2) {
      throw new Error(
        label + ': Ort/Gemeinde ist für den bestätigten Feiertagskontext erforderlich.',
      );
    }
    if (region === 'DE-BY' && bavariaAssumption === 'UNKNOWN') {
      throw new Error(label + ': Die örtliche Geltung von Mariä Himmelfahrt muss feststehen.');
    }
  }
  if ((note?.trim().length ?? 0) < 3) {
    throw new Error(label + ': Kalenderquelle oder Prüfnachweis muss kurz dokumentiert werden.');
  }
}

function toBavariaAssumption(value: string): boolean | null {
  return value === 'YES' ? true : value === 'NO' ? false : null;
}

function prepareCreateNotice(formData: FormData): PreparedCreateNotice {
  const data = parseCreateNoticeInput(formData);
  const noticeDate = new Date(`${data.noticeDate}T00:00:00.000Z`);
  // Tatsächlicher Zugang: nur plausible Werte übernehmen (nicht vor dem
  // Versand-/Bereitstellungstag — ein Bescheid kann nicht vorher zugehen).
  const receivedAt = optionalYmdToDate(data.receivedAt);
  const retrievalIssuedAt = optionalYmdToDate(data.retrievalIssuedAt);
  const retrievalNotificationDate = optionalYmdToDate(data.retrievalNotificationDate);
  const retrievedAt = optionalYmdToDate(data.retrievedAt);
  const retrievalPostalRequestReceivedAt = optionalYmdToDate(data.retrievalPostalRequestReceivedAt);
  const recipientLocalHolidayDates = localHolidayDates(
    data.recipientLocalHolidayDates,
    'Empfängerort – örtliche Feiertage',
  );
  const authorityLocalHolidayDates = localHolidayDates(
    data.authorityLocalHolidayDates,
    'Behördensitz – örtliche Feiertage',
  );
  const today = berlinCalendarDate(new Date());
  validateGeneralDeliveryEvidence(data, noticeDate, receivedAt, today);

  validateHolidayContext(
    'Empfängerort',
    data.recipientCountryCode,
    data.recipientRegion,
    data.recipientLocality,
    data.recipientHolidayContextStatus,
    data.recipientBavariaAssumption,
    data.holidayContextNote,
  );
  validateHolidayContext(
    'Behördensitz',
    data.authorityCountryCode,
    data.authorityRegion,
    data.authorityLocality,
    data.authorityHolidayContextStatus,
    data.authorityBavariaAssumption,
    data.holidayContextNote,
  );
  const retrievalValidation = validateDataRetrievalEvidence({
    deliveryMethod: data.deliveryMethod,
    provisionDate: noticeDate,
    issuedAt: retrievalIssuedAt,
    notificationDate: retrievalNotificationDate,
    notificationDisputedOrLate: data.retrievalNotificationDisputedOrLate,
    retrievedAt,
    consentStatus: data.retrievalConsentStatus,
    eligibility2027Status: data.retrievalEligibility2027Status,
    postalRequestStatus: data.retrievalPostalRequestStatus,
    postalRequestReceivedAt: retrievalPostalRequestReceivedAt,
    notificationStatus: data.retrievalNotificationStatus,
    today,
  });
  if (!retrievalValidation.ok) throw new Error(retrievalValidation.error);

  const assessment = assessNoticeEvidence({
    deliveryMethod: data.deliveryMethod,
    noticeDate,
    dateBasis: data.dateBasis,
    deliveryEvidenceStatus: data.deliveryEvidenceStatus,
    legalRemedyInstructionStatus: data.legalRemedyInstruction,
    accessStatus: data.accessStatus,
    receivedAt,
    accessEvidenceStatus: (data.accessEvidenceStatus || null) as EvidenceStatus | null,
    recipientHolidayContext: holidayContext({
      countryCode: data.recipientCountryCode,
      region: data.recipientRegion || null,
      locality: data.recipientLocality?.trim() || null,
      calendarStatus: data.recipientHolidayContextStatus,
      bavariaAssumptionApplies: toBavariaAssumption(data.recipientBavariaAssumption),
      localHolidays: recipientLocalHolidayDates,
    }),
    authorityHolidayContext: holidayContext({
      countryCode: data.authorityCountryCode,
      region: data.authorityRegion || null,
      locality: data.authorityLocality?.trim() || null,
      calendarStatus: data.authorityHolidayContextStatus,
      bavariaAssumptionApplies: toBavariaAssumption(data.authorityBavariaAssumption),
      localHolidays: authorityLocalHolidayDates,
    }),
    retrieval: {
      issuedAt: retrievalIssuedAt,
      notificationDate: retrievalNotificationDate,
      notificationDisputedOrLate: data.retrievalNotificationDisputedOrLate,
      retrievedAt,
      consentStatus: data.retrievalConsentStatus,
      eligibility2027Status: data.retrievalEligibility2027Status,
      postalRequestStatus: data.retrievalPostalRequestStatus,
      postalRequestReceivedAt: retrievalPostalRequestReceivedAt,
      notificationStatus: data.retrievalNotificationStatus,
    },
  });

  return {
    data,
    noticeDate,
    receivedAt,
    retrievalIssuedAt,
    retrievalNotificationDate,
    retrievedAt,
    retrievalPostalRequestReceivedAt,
    recipientLocalHolidayDates,
    authorityLocalHolidayDates,
    assessment,
    legalRemedyInstructionValid: data.legalRemedyInstruction === 'WIRKSAM',
  };
}

export async function createNoticeAction(formData: FormData): Promise<void> {
  // void/throw-Form-Action: Gate liefert die Fehlermeldung als Wurf (Vertrag bleibt).
  const g = await staffActionGuard({ module: 'taxNotices' });
  if (!g.ok) throw new Error(g.error);
  const { tenantId, staffId, ctx, session } = g;
  const {
    data: d,
    noticeDate,
    receivedAt,
    retrievalIssuedAt,
    retrievalNotificationDate,
    retrievedAt,
    retrievalPostalRequestReceivedAt,
    recipientLocalHolidayDates,
    authorityLocalHolidayDates,
    assessment,
    legalRemedyInstructionValid,
  } = prepareCreateNotice(formData);

  await withTenantContext(ctx, async (tx) => {
    await assertClientAccessTx(tx, session, d.clientId);
    // Q-5: clientId muss im aktuellen Tenant existieren — sonst kann ein
    // UI-Bug / direkter API-Call eine fremde clientId persistieren.
    await assertClientInTenant(tx, d.clientId);
    // Auto-Match: bestehende TaxFiling für gleichen Mandant/Steuerart/Zeitraum?
    // Wenn ja, übernehmen wir deren Soll-Wert als expectedAmount (sofern nicht
    // explizit gesetzt) und verknüpfen die beiden Datensätze.
    const matchingFiling = await tx.taxFiling.findUnique({
      where: {
        tenantId_clientId_kind_period: {
          tenantId,
          clientId: d.clientId,
          kind: d.kind,
          period: d.period,
        },
      },
    });
    const expectedFromFiling = matchingFiling?.expectedAssessed
      ? matchingFiling.expectedAssessed.toFixed(2)
      : undefined;

    const created = await tx.taxNotice.create({
      data: {
        tenantId,
        clientId: d.clientId,
        kind: d.kind,
        period: d.period,
        noticeDate,
        dateBasis: d.dateBasis,
        deliveryMethod: d.deliveryMethod,
        deliveryEvidenceStatus: d.deliveryEvidenceStatus,
        deliveryEvidenceNote: trimmedOrNull(d.deliveryEvidenceNote),
        legalRemedyInstructionValid,
        legalRemedyInstructionStatus: d.legalRemedyInstruction,
        legalRemedyInstructionNote: d.legalRemedyInstructionNote.trim(),
        receivedAt,
        accessStatus: d.accessStatus,
        accessEvidenceStatus: emptyStringOrNull(d.accessEvidenceStatus),
        accessEvidenceNote: trimmedOrNull(d.accessEvidenceNote),
        recipientName: d.recipientName.trim(),
        recipientCountryCode: d.recipientCountryCode,
        recipientRegion: emptyStringOrNull(d.recipientRegion),
        recipientLocality: trimmedOrNull(d.recipientLocality),
        recipientLocalHolidayDates,
        recipientBavariaAssumptionApplies: toBavariaAssumption(d.recipientBavariaAssumption),
        recipientHolidayContextStatus: d.recipientHolidayContextStatus,
        authorityName: d.authorityName.trim(),
        authorityCountryCode: d.authorityCountryCode,
        authorityRegion: emptyStringOrNull(d.authorityRegion),
        authorityLocality: trimmedOrNull(d.authorityLocality),
        authorityLocalHolidayDates,
        authorityBavariaAssumptionApplies: toBavariaAssumption(d.authorityBavariaAssumption),
        authorityHolidayContextStatus: d.authorityHolidayContextStatus,
        holidayContextNote: trimmedOrNull(d.holidayContextNote),
        retrievalIssuedAt,
        retrievalNotificationDate,
        retrievalNotificationDisputedOrLate: d.retrievalNotificationDisputedOrLate,
        retrievedAt,
        retrievalConsentStatus: d.retrievalConsentStatus,
        retrievalEligibility2027Status: d.retrievalEligibility2027Status,
        retrievalPostalRequestStatus: d.retrievalPostalRequestStatus,
        retrievalPostalRequestReceivedAt,
        retrievalNotificationStatus: d.retrievalNotificationStatus,
        retrievalReinstatementReviewRequired: assessment.reinstatementReviewRequired,
        calculatedNotificationDate: assessment.notificationDate,
        appealDeadline: assessment.appealDeadline,
        internalRiskDeadline: assessment.internalRiskDeadline,
        alternativeClaimedAccessDeadline: assessment.alternativeClaimedAccessDeadline,
        deadlineCalculationStatus: assessment.calculationStatus,
        deadlineCalculationVersion: NOTICE_DEADLINE_CALCULATION_VERSION,
        manualReviewRequired: assessment.manualReviewRequired,
        manualReviewReason: joinedReasonsOrNull(assessment.manualReviewReasons),
        fileNumber: valueOrNull(d.fileNumber),
        assessedAmount: parseDecimal(d.assessedAmount),
        expectedAmount: parseDecimal(d.expectedAmount) ?? expectedFromFiling,
        prepaidAmount: parseDecimal(d.prepaidAmount),
        payAmount: parseDecimal(d.payAmount),
        reviewNotes: valueOrNull(d.reviewNotes),
        filingId: valueOrNull(matchingFiling?.id),
        createdByStaff: staffId,
      },
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tax_notice.create',
      resourceType: 'tax_notice',
      resourceId: created.id,
      after: taxNoticeCreateAudit(created),
    });
  });

  revalidatePath(`/staff/clients/${d.clientId}/notices`);
  redirect(`/staff/clients/${d.clientId}/notices`);
}

const NOTICE_STATUS_VALUES = [
  'NEU',
  'GEPRUEFT',
  'EINSPRUCH',
  'ABGEHOLFEN',
  'TEILABHILFE',
  'TEILEINSPRUCHSENTSCHEIDUNG',
  'ZURUECKGEWIESEN',
  'KLAGE',
  'BESTANDSKRAEFTIG',
] as const;

/**
 * Status-Transition für Bescheide (Quick-Actions im Bescheid-Postfach).
 * Erlaubte Übergänge: NOTICE_STATUS_TRANSITIONS (./transitions.ts). Relevanz:
 * erst ab GEPRUEFT erscheint der Bescheid im Mandantenportal. Side-Effects:
 * GEPRUEFT setzt reviewedAt/-By, EINSPRUCH appealFiledAt und ABGEHOLFEN/
 * ZURUECKGEWIESEN appealResolvedAt. TEILABHILFE lässt das
 * Einspruchsverfahren offen; zurück auf NEU räumt den Prüfvermerk.
 */
export async function updateNoticeStatusAction(input: {
  noticeId: string;
  status: string;
  /** Tatsächlicher Ereignistag für fristauslösende/-wahrende Übergänge. */
  eventDate?: string;
  decisionLegalRemedyInstruction?: 'VALID' | 'MISSING_OR_INVALID';
  /** Begründete Berufsträgerentscheidung bei BESTANDSKRAEFTIG. */
  legalFinalReason?: string;
  /**
   * Explizit bestätigte Nachweise für offene Altverfahren, deren Ereignisfelder
   * vor Einführung des Fristennachweises noch nicht gespeichert wurden.
   */
  legacyEvidence?: {
    appealFiledDate?: string;
    appealResolvedDate?: string;
    partialReliefReceivedDate?: string;
    appealDecisionReceivedDate?: string;
    klageFiledDate?: string;
  };
}): Promise<ActionResult> {
  const g = await staffActionGuard({ module: 'taxNotices' });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx, session } = g;

  const parsed = z
    .object({
      noticeId: z.string().uuid(),
      status: z.enum(NOTICE_STATUS_VALUES),
      eventDate: YmdSchema.optional(),
      decisionLegalRemedyInstruction: z.enum(['VALID', 'MISSING_OR_INVALID']).optional(),
      legalFinalReason: z.string().trim().min(10).max(2_000).optional(),
      legacyEvidence: z
        .object({
          appealFiledDate: YmdSchema.optional(),
          appealResolvedDate: YmdSchema.optional(),
          partialReliefReceivedDate: YmdSchema.optional(),
          appealDecisionReceivedDate: YmdSchema.optional(),
          klageFiledDate: YmdSchema.optional(),
        })
        .strict()
        .optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const {
    noticeId,
    status,
    eventDate: eventDateInput,
    decisionLegalRemedyInstruction,
    legalFinalReason,
    legacyEvidence,
  } = parsed.data;

  const needsEventDate =
    status === 'EINSPRUCH' ||
    status === 'ABGEHOLFEN' ||
    status === 'TEILABHILFE' ||
    status === 'TEILEINSPRUCHSENTSCHEIDUNG' ||
    status === 'ZURUECKGEWIESEN' ||
    status === 'KLAGE' ||
    status === 'BESTANDSKRAEFTIG';
  if (needsEventDate && !eventDateInput) {
    return { ok: false, error: 'Der tatsächliche Ereignistag ist für diesen Status erforderlich.' };
  }
  const isDecisionStatus = status === 'TEILEINSPRUCHSENTSCHEIDUNG' || status === 'ZURUECKGEWIESEN';
  const suppliesLegacyDecision = Boolean(legacyEvidence?.appealDecisionReceivedDate);
  if ((isDecisionStatus || suppliesLegacyDecision) && !decisionLegalRemedyInstruction) {
    return {
      ok: false,
      error: 'Die Rechtsbehelfsbelehrung der Einspruchsentscheidung muss geprüft werden.',
    };
  }
  const decisionLegalRemedyInstructionValid =
    isDecisionStatus || suppliesLegacyDecision ? decisionLegalRemedyInstruction === 'VALID' : null;
  const eventDate = optionalYmdToDate(eventDateInput);
  if (status === 'BESTANDSKRAEFTIG') {
    if (!isStaffAdmin(session)) {
      return {
        ok: false,
        error:
          'Die Bestandskraft kann nur durch Partner oder Administration fachlich festgestellt werden.',
      };
    }
    if (!legalFinalReason) {
      return {
        ok: false,
        error: 'Die fachliche Abschlussentscheidung muss begründet werden.',
      };
    }
  }
  const legacyAppealFiledAt = optionalYmdToDate(legacyEvidence?.appealFiledDate);
  const legacyAppealResolvedAt = optionalYmdToDate(legacyEvidence?.appealResolvedDate);
  const legacyPartialReliefReceivedAt = optionalYmdToDate(
    legacyEvidence?.partialReliefReceivedDate,
  );
  const legacyDecisionReceivedAt = optionalYmdToDate(legacyEvidence?.appealDecisionReceivedDate);
  const legacyKlageFiledAt = optionalYmdToDate(legacyEvidence?.klageFiledDate);
  const submittedDates = [
    eventDate,
    legacyAppealFiledAt,
    legacyAppealResolvedAt,
    legacyPartialReliefReceivedAt,
    legacyDecisionReceivedAt,
    legacyKlageFiledAt,
  ].filter((date): date is Date => date !== null);
  const today = berlinCalendarDate(new Date());
  if (submittedDates.some((date) => date.getTime() > today.getTime())) {
    return { ok: false, error: 'Der Ereignistag darf nicht in der Zukunft liegen.' };
  }

  let clientId: string | null = null;
  let result: ActionResult;
  try {
    result = await withTenantContext(ctx, async (tx): Promise<ActionResult> => {
      const before = await tx.taxNotice.findFirst({
        where: { id: noticeId, tenantId },
        select: {
          id: true,
          status: true,
          clientId: true,
          noticeDate: true,
          appealDeadline: true,
          deadlineCalculationStatus: true,
          manualReviewRequired: true,
          reviewedAt: true,
          appealFiledAt: true,
          appealFiledBy: true,
          partialReliefReceivedAt: true,
          partialReliefReceivedBy: true,
          appealResolvedAt: true,
          appealDecisionReceivedAt: true,
          appealDecisionLegalRemedyInstructionValid: true,
          klageDeadline: true,
          klageFiledAt: true,
          klageFiledBy: true,
          authorityRegion: true,
          authorityCountryCode: true,
          authorityLocality: true,
          authorityLocalHolidayDates: true,
          authorityBavariaAssumptionApplies: true,
          authorityHolidayContextStatus: true,
        },
      });
      if (!before) return { ok: false, error: 'Bescheid nicht gefunden.' };
      clientId = before.clientId;
      await assertClientAccessTx(tx, session, before.clientId);

      const plan = planNoticeTransition({
        before,
        request: {
          status,
          eventDateInput,
          eventDate,
          decisionLegalRemedyInstructionValid,
          legalFinalReason: legalFinalReason ?? null,
          legacyEvidence,
          legacyAppealFiledAt,
          legacyAppealResolvedAt,
          legacyPartialReliefReceivedAt,
          legacyDecisionReceivedAt,
          legacyKlageFiledAt,
        },
        staffId,
        now: new Date(),
        // TAX-DEADLINE-WORKDAY-001: Für die Klagefrist zählt ausschließlich
        // der am Bescheid dokumentierte und geprüfte Behördensitz. Örtliche
        // Ausnahmen bleiben Teil der reproduzierbaren Berechnungsgrundlage.
        deadlineHolidayContext: holidayContext({
          countryCode: before.authorityCountryCode,
          region: before.authorityRegion,
          locality: before.authorityLocality,
          calendarStatus: before.authorityHolidayContextStatus,
          bavariaAssumptionApplies: before.authorityBavariaAssumptionApplies,
          localHolidays: before.authorityLocalHolidayDates,
        }),
      });
      if (!plan.ok) return plan;

      // TOCTOU-Schutz: nur aus dem gelesenen Ausgangsstatus heraus wechseln.
      // Zwei parallele, einzeln gültige Übergänge aus demselben Status würden
      // sonst appealFiledAt/reviewedAt überschreiben (§ 122 (2)-Nachweis).
      const claim = await tx.taxNotice.updateMany({
        where: { id: noticeId, status: before.status },
        data: plan.data,
      });
      if (claim.count === 0) {
        return {
          ok: false,
          error: 'Status wurde zwischenzeitlich geändert — bitte Seite neu laden.',
        };
      }
      await resolveNotificationsTx(tx, {
        tenantId,
        resources: [{ resourceType: 'tax_notice', resourceId: noticeId }],
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'tax_notice.status',
        resourceType: 'tax_notice',
        resourceId: noticeId,
        before: taxNoticeStatusBeforeAudit(before),
        after: taxNoticeStatusAfterAudit(noticeId, plan.auditAfter, plan.data),
      });
      return { ok: true };
    });
  } catch (e) {
    return toActionError(e);
  }

  if (result.ok && clientId) revalidatePath(`/staff/clients/${clientId}/notices`);
  return result;
}
