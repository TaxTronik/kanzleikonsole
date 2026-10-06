// Review-Befund R-12/K-02: Die Einstellungsformulare (Kanzlei, Briefkopf,
// rechtliche Hinweise, Bundesland, TSA, SMTP, Mail-Dispatch, Module,
// Zugriffsmodell, Portal) lesen über parseFormData und laufen über
// staffAction. Vorgaben fehlender Felder, Umwandlungen und Gesamtmeldungen
// bleiben wie bei den bisherigen formData.get-Ketten; Ablehnungen tragen
// zusätzlich errorCode und die Feldzuordnung. Gate (ADMIN/PARTNER), Audit
// und Revalidierung wie zuvor.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const writes: Array<[string, unknown[]]> = [];
  const write =
    (name: string) =>
    async (...args: unknown[]): Promise<void> => {
      writes.push([name, args.slice(1)]);
    };
  return {
    staffActionGuard: vi.fn(),
    writes,
    write,
    audits: [] as unknown[],
    revalidated: [] as unknown[][],
    readSmtpConfig: vi.fn(),
  };
});
vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => h.revalidated.push(args),
}));
vi.mock('@taxtronik/config', () => ({ env: { NODE_ENV: 'test' } }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock('@/server/container', () => ({
  evidenceService: { record: async (_tx: unknown, event: unknown) => h.audits.push(event) },
}));
vi.mock('@/server/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/server/settings/tenant-settings', () => ({ writeSellerInfoTx: h.write('seller') }));
vi.mock('@/server/settings/branding', () => ({
  writeBrandingTx: h.write('branding'),
  invalidateBrandingCache: vi.fn(),
}));
vi.mock('@/server/settings/letterhead', () => ({ writeLetterheadTx: h.write('letterhead') }));
vi.mock('@/server/settings/legal', () => ({ writeLegalTx: h.write('legal') }));
vi.mock('@/server/settings/tax-region', () => ({ writeTaxRegionTx: h.write('taxRegion') }));
vi.mock('@/server/settings/tsa', () => ({ writeTsaConfigTx: h.write('tsa') }));
vi.mock('@/server/settings/smtp', () => ({
  readSmtpConfig: h.readSmtpConfig,
  writeSmtpConfigTx: h.write('smtp'),
  deleteSmtpConfigTx: h.write('smtpReset'),
}));
vi.mock('@/server/mail/send', () => ({ sendTestMail: vi.fn() }));
vi.mock('@/server/settings/mail-dispatch', () => ({ writeMailDispatchTx: h.write('dispatch') }));
vi.mock('@/server/settings/modules', () => ({ writeModulesTx: h.write('modules') }));
vi.mock('@/server/settings/access-policy', () => ({ writeAccessPolicyTx: h.write('access') }));
vi.mock('@/server/settings/client-layout', () => ({
  writeClientLayoutTx: h.write('layout'),
  ALL_CLIENT_BLOCKS: ['stammdaten'],
  DEFAULT_CLIENT_LAYOUT: { items: [] },
}));
vi.mock('@/server/settings/portal-features', () => ({
  writePortalFeaturesTx: h.write('portalFeatures'),
}));
vi.mock('@/server/inbox/retention-settings', () => ({
  writePortalInboxRetentionTx: h.write('retention'),
}));
vi.mock('@/server/http/ssrf-guard', () => ({
  assertPublicUrl: vi.fn(),
  urlTargetErrorMessage: () => null,
}));
vi.mock('@taxtronik/evidence', () => ({
  createRfc3161Adapter: vi.fn(),
  getTsaProvider: vi.fn(),
}));
vi.mock('@/server/actions/staff-action', async () => ({
  staffActionGuard: h.staffActionGuard,
  // K-02: echter mehrphasiger Ablauf über dem Gate-Mock.
  staffAction: (
    await vi.importActual<typeof import('@/server/actions/action-runner')>(
      '@/server/actions/action-runner',
    )
  ).createActionRunner(h.staffActionGuard),
}));

import {
  saveBrandingAction,
  saveLegalAction,
  saveLetterheadAction,
  saveSellerInfoAction,
} from '../branding-actions';
import { saveTaxRegionAction, saveTsaAction } from '../infra-actions';
import { saveMailDispatchAction, saveSmtpAction } from '../mail-actions';
import {
  saveAccessPolicyAction,
  saveModulesAction,
  savePortalFeaturesAction,
} from '../modules-actions';

type Entries = Array<[string, string | File]>;

function form(entries: Entries): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}

/** Abgelehnt mit der bisherigen Gesamtmeldung, zugeordnet zu genau diesen Feldern. */
function expectRejected(result: unknown, error: string, fields: string[]) {
  expect(result).toMatchObject({ ok: false, error, errorCode: 'VALIDATION_ERROR' });
  expect(Object.keys((result as { fieldErrors: object }).fieldErrors).sort()).toEqual(
    [...fields].sort(),
  );
  expect(h.writes).toEqual([]);
  expect(h.audits).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.writes.length = 0;
  h.audits.length = 0;
  h.revalidated.length = 0;
  h.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    session: { user: {} },
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
  });
  h.readSmtpConfig.mockResolvedValue({ password: 'gespeichert' });
});

describe('Kanzlei-Identität', () => {
  it('speichert fehlende Angaben als null, den Ländercode groß und fehlend als DE', async () => {
    expect(await saveSellerInfoAction(null, form([['name', 'Kanzlei Muster']]))).toEqual({
      ok: true,
    });
    expect(
      await saveSellerInfoAction(
        null,
        form([
          ['name', 'Kanzlei Muster'],
          ['countryIso', 'at'],
        ]),
      ),
    ).toEqual({ ok: true });

    expect(h.staffActionGuard).toHaveBeenCalledWith({ requireAdmin: true });
    expect(h.writes).toEqual([
      [
        'seller',
        [
          { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
          {
            name: 'Kanzlei Muster',
            street: null,
            postalCode: null,
            city: null,
            countryIso: 'DE',
            vatId: null,
            taxNumber: null,
            email: null,
            phone: null,
            iban: null,
            bic: null,
            bankName: null,
          },
        ],
      ],
      ['seller', [expect.anything(), expect.objectContaining({ countryIso: 'AT' })]],
    ]);
    expect(h.audits[0]).toMatchObject({
      tenantId: 'tenant-1',
      actorType: 'STAFF',
      actorId: 'staff-1',
      action: 'tenant.settings.seller.update',
      after: { name: 'Kanzlei Muster', vatId: null, iban: null },
    });
    expect(h.revalidated).toEqual([['/staff/admin/settings'], ['/staff/admin/settings']]);
  });

  it('lehnt einen leeren Ländercode und eine ungültige E-Mail ab', async () => {
    expectRejected(
      await saveSellerInfoAction(
        null,
        form([
          ['name', 'Kanzlei'],
          ['countryIso', ''],
          ['email', 'keine-mail'],
        ]),
      ),
      'Validierungsfehler.',
      ['countryIso', 'email'],
    );
  });

  it('meldet Branding-Fehler gesammelt und prüft das Logo-Format danach', async () => {
    expectRejected(
      await saveBrandingAction(null, form([['accentColor', 'blau']])),
      'Invalid input: expected string, received null; Hex-Farbe wie #2563eb',
      ['displayName', 'accentColor'],
    );
    expect(
      await saveBrandingAction(
        null,
        form([
          ['displayName', 'Kanzlei'],
          ['accentColor', '#2563EB'],
          ['logoDataUrl', 'data:image/svg+xml;base64,AA'],
        ]),
      ),
    ).toEqual({ ok: false, error: 'Ungültiges Logo-Format.' });
    expect(h.writes).toEqual([]);
  });

  it('übernimmt beim Briefkopf keine fehlenden Felder (wie bisher kein Default für null)', async () => {
    expectRejected(
      await saveLetterheadAction(
        null,
        form([
          ['organisationName', 'Kanzlei'],
          ['addressLines', 'Weg 1'],
          ['contactLine', ''],
        ]),
      ),
      'Validierungsfehler.',
      ['footnote'],
    );
  });

  it('lässt rechtliche Hinweise leer zu und meldet sonst die erste Ursache', async () => {
    expect(await saveLegalAction(null, form([]))).toEqual({ ok: true });
    expect(h.writes).toEqual([
      ['legal', [expect.anything(), { impressumUrl: '', privacyUrl: '' }]],
    ]);
    expect(h.revalidated).toEqual([['/staff/admin/settings/branding'], ['/staff/admin/privacy']]);

    h.writes.length = 0;
    h.audits.length = 0;
    expectRejected(
      await saveLegalAction(null, form([['impressumUrl', 'keine url']])),
      'Invalid URL',
      ['impressumUrl'],
    );
  });
});

describe('Infrastruktur', () => {
  it('speichert den Feiertags-Haken nur für Bayern und dort schon bei leerem Wert', async () => {
    await saveTaxRegionAction(
      null,
      form([
        ['region', 'DE-BY'],
        ['assumptionHoliday', ''],
      ]),
    );
    await saveTaxRegionAction(null, form([['region', 'DE-BY']]));
    await saveTaxRegionAction(null, form([['region', 'DE-HE']]));
    await saveTaxRegionAction(null, form([['region', 'XX']]));

    expect(h.writes.map(([, args]) => args.slice(1))).toEqual([
      ['DE-BY', true],
      ['DE-BY', false],
      ['DE-HE', true],
      [null, true],
    ]);
  });

  it('nimmt eine fehlende TSA-Auswahl als Self-Timestamp (außerhalb der Produktion)', async () => {
    expect(await saveTsaAction(null, form([]))).toEqual({ ok: true });
    expect(h.writes).toEqual([['tsa', [expect.anything(), { providerId: '', customUrl: '' }]]]);
    expect(h.revalidated).toEqual([['/staff/admin/settings/evidence'], ['/staff/admin']]);
  });
});

describe('E-Mail-Versand', () => {
  it('liest Schalter nur bei „on“ und übernimmt fehlende Felder als leer', async () => {
    expect(
      await saveSmtpAction(
        null,
        form([
          ['host', ' smtp.example '],
          ['port', '587'],
          ['secure', 'on'],
          ['from', 'kanzlei@example.de'],
          ['keepPassword', 'on'],
        ]),
      ),
    ).toEqual({ ok: true });

    expect(h.readSmtpConfig).toHaveBeenCalledOnce();
    expect(h.writes).toEqual([
      [
        'smtp',
        [
          expect.anything(),
          {
            host: 'smtp.example',
            port: 587,
            secure: true,
            user: '',
            password: 'gespeichert',
            from: 'kanzlei@example.de',
            replyTo: '',
          },
        ],
      ],
    ]);
  });

  it('meldet SMTP-Fehler wie bisher mit Feldpfad', async () => {
    expectRejected(
      await saveSmtpAction(
        null,
        form([
          ['host', 'smtp.example'],
          ['port', 'abc'],
          ['from', ''],
        ]),
      ),
      'port: Invalid input: expected number, received NaN; from: Too small: expected string to have >=1 characters',
      ['port', 'from'],
    );
    expectRejected(
      await saveMailDispatchAction(null, form([['mode', 'X']])),
      'Validierungsfehler.',
      ['mode'],
    );
  });
});

describe('Module, Zugriffsmodell und Portal', () => {
  it('liest Modul-Haken `enabled.<Modul>` nur bei „on“ und setzt den PDF-Betreff-Default', async () => {
    expect(
      await saveModulesAction(
        null,
        form([
          ['enabled.bwa', 'on'],
          ['enabled.smartMailbox', 'on'],
          ['enabled.risk', '1'],
          ['poaMode', 'PDF_TEMPLATE'],
          ['invoiceMode', 'OFF'],
        ]),
      ),
    ).toEqual({ ok: true });

    const [[, [, cfg]]] = h.writes as [[string, [unknown, Record<string, unknown>]]];
    expect(cfg).toMatchObject({
      bwa: true,
      smartMailbox: true,
      risk: false,
      knowledge: false,
      subsumtionFloatingToolbarDefault: false,
      poaMode: 'PDF_TEMPLATE',
      poaPdfTemplate: { subject: 'Vollmacht zur Unterzeichnung', bodyMd: '' },
      invoiceMode: 'OFF',
      invoicePdfTemplate: null,
    });
    expect(h.revalidated).toEqual([['/staff/admin/settings'], ['/staff', 'layout']]);
  });

  it('lehnt fehlende Modi und ein ungültiges Zugriffsmodell ab', async () => {
    expectRejected(await saveModulesAction(null, form([])), 'Validierungsfehler.', [
      'poaMode',
      'invoiceMode',
    ]);
    expectRejected(
      await saveAccessPolicyAction(null, form([['clientAccessMode', 'ALL']])),
      'Validierungsfehler.',
      ['clientAccessMode'],
    );
  });

  it('nimmt eine fehlende Aufbewahrungsdauer als 365 Tage, lehnt eine leere ab', async () => {
    expect(await savePortalFeaturesAction(null, form([['bwaView', 'on']]))).toEqual({ ok: true });
    expect(h.writes[0]).toEqual([
      'retention',
      ['tenant-1', 'staff-1', { messageRetentionDays: 365, organizationallyDocumented: false }],
    ]);

    h.writes.length = 0;
    h.audits.length = 0;
    expectRejected(
      await savePortalFeaturesAction(null, form([['messageRetentionDays', '']])),
      'Bitte prüfen Sie die markierten Angaben.',
      ['messageRetentionDays'],
    );
    expect(await savePortalFeaturesAction(null, form([['clientInbox', 'on']]))).toMatchObject({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { retentionDocumented: [expect.any(String)] },
    });
  });

  it('gibt die Ablehnung des Gates unverändert zurück', async () => {
    h.staffActionGuard.mockResolvedValue({ ok: false, error: 'Nur ADMIN/PARTNER.' });

    expect(await saveModulesAction(null, form([]))).toEqual({
      ok: false,
      error: 'Nur ADMIN/PARTNER.',
    });
    expect(h.writes).toEqual([]);
  });
});
