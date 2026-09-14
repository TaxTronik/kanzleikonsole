import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  consentForNewDeclaration,
  defaultConsentOptionsCatalog,
  type ResolvedConsentOption,
} from '../consent';

vi.mock('@/components/gwg/identity-capture', () => ({ IdentityCapture: () => null }));
vi.mock('@/app/gwg-onboarding/actions', () => ({ loadOnboardingIdentitySourceAction: vi.fn() }));
vi.mock('@/app/staff/(protected)/admin/privacy/actions', () => ({
  saveConsentOptionsAction: vi.fn(),
}));

import { PrivacyStep } from '@/app/gwg-onboarding/wizard-steps';
import { ConsentOptionsEditor } from '@/app/staff/(protected)/admin/privacy/consent-options-editor';
import { ConsentFields } from '@/components/consent-fields';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function read(relativePath: string): string {
  return readFileSync(resolve(webRoot, relativePath), 'utf8');
}

function optionsWithRequiredSections(): ResolvedConsentOption[] {
  return [
    ...defaultConsentOptionsCatalog().options.map((option) => ({
      ...option,
      required: ['communication.phone', 'marketing.emailNewsletter'].includes(option.id),
      serviceProvider: null,
      providerMissing: false,
    })),
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      builtin: false,
      section: 'OTHER',
      label: 'Eigene Bestätigung',
      description: null,
      active: true,
      required: true,
      recommended: false,
      sortOrder: 200,
      serviceProviderId: null,
      serviceProvider: null,
      providerMissing: false,
    },
  ];
}

function renderPrivacyStep(consentOptions: ResolvedConsentOption[]) {
  return renderToStaticMarkup(
    createElement(PrivacyStep, {
      noticeVersion: 4,
      noticeBody: '# Datenschutzhinweise',
      consent: consentForNewDeclaration(),
      consentOptions,
      noticeAck: false,
      signedByName: '',
      onConsentChange: vi.fn(),
      onNoticeAckChange: vi.fn(),
      onSignedByNameChange: vi.fn(),
    }),
  );
}

function checkboxesIn(html: string): string[] {
  return [...html.matchAll(/<input\b[^>]*type="checkbox"[^>]*>/g)].map(([input]) => input);
}

describe('Einwilligungsrichtlinien in der UI', () => {
  it('bietet für jede aktive Option eine Kanzleivorgabe ohne Vorauswahl an', () => {
    const editor = read('app/staff/(protected)/admin/privacy/consent-options-editor.tsx');

    expect(editor).toContain('Zwingend');
    expect(editor).toContain('Als Empfehlung hervorheben');
    expect(editor).toContain('Bleibt im Portal ungekreuzt');
    expect(editor).toContain('Ohne Bestätigung kann das Onboarding nicht abgeschlossen werden.');
    expect(editor).not.toContain("option.section === 'OTHER'");
    expect(editor).toContain('patch(option.id, { section })');
    expect(editor).not.toContain('defaultSelected');
    expect(editor).toContain('version: 2');
  });

  it('DSGVO-CONSENT-SNAPSHOT-001: renders a mandatory toggle for all active catalogue options', () => {
    const options = optionsWithRequiredSections();
    options[0] = { ...options[0]!, active: false, required: false };
    const html = renderToStaticMarkup(
      createElement(ConsentOptionsEditor, { initial: options, providers: [], revision: 'fixture' }),
    );
    const requiredLabels = [...html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)]
      .map(([, content]) => content!)
      .filter((content) => content.includes('Zwingend'));
    expect(requiredLabels).toHaveLength(options.filter((option) => option.active).length);
    expect(requiredLabels.filter((label) => /\bchecked=""/.test(label))).toHaveLength(3);
  });

  it('DSGVO-CONSENT-SNAPSHOT-001: marks only acknowledgement as required in the standard catalogue', () => {
    const html = renderPrivacyStep(
      defaultConsentOptionsCatalog().options.map((option) => ({
        ...option,
        serviceProvider: null,
        providerMissing: false,
      })),
    );
    const checkboxes = checkboxesIn(html);
    expect(checkboxes).toHaveLength(12);
    expect(checkboxes.filter((input) => /\brequired=""/.test(input))).toHaveLength(1);
    expect(checkboxes.every((input) => !/\bchecked=""/.test(input))).toBe(true);
    expect(html).toContain('Zwingend');
    expect(html).toContain('Ich habe die Datenschutzhinweise zur Kenntnis genommen.');
    expect(html).toContain('Alle Optionen in diesem Bereich sind optional.');
    expect(html).toContain('Einwilligungen bleiben widerrufbar.');
    expect(html.indexOf('Kenntnisnahme')).toBeLessThan(html.indexOf('Kontaktwege'));
  });

  it('DSGVO-CONSENT-SNAPSHOT-001: renders required communication, marketing and custom choices unchecked', () => {
    const html = renderPrivacyStep(optionsWithRequiredSections());
    const checkboxes = checkboxesIn(html);
    expect(checkboxes).toHaveLength(13);
    expect(checkboxes.filter((input) => /\brequired=""/.test(input))).toHaveLength(4);
    expect(checkboxes.every((input) => !/\bchecked=""/.test(input))).toBe(true);
    const requiredLabels = [...html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)]
      .map(([, content]) => content!)
      .filter((content) => /\brequired=""/.test(content));
    for (const text of [
      'Kenntnis genommen',
      'Telefon',
      'E-Mail-Newsletter',
      'Eigene Bestätigung',
    ]) {
      expect(requiredLabels.some((label) => label.includes(text))).toBe(true);
    }
    expect(html).toContain(
      'Zwingend markierte Optionen müssen für den Onboarding-Abschluss bestätigt werden.',
    );
    expect(html).not.toContain('Alle Optionen in diesem Bereich sind optional.');
    expect(html).toContain('Einwilligungen bleiben widerrufbar.');
  });

  it('keeps partial staff recording possible while showing the onboarding requirement', () => {
    const html = renderToStaticMarkup(
      createElement(ConsentFields, { options: optionsWithRequiredSections(), mode: 'staff' }),
    );
    expect(checkboxesIn(html).some((input) => /\brequired=""/.test(input))).toBe(false);
    expect(html).toContain('Zwingend');
  });

  it('beginnt neue Erklärungen ungekreuzt und zeigt Empfehlungen nur semantisch an', () => {
    const fields = read('components/consent-fields.tsx');
    const wizard = read('app/gwg-onboarding/wizard.tsx');

    expect(fields).toContain('initial ?? consentForNewDeclaration()');
    expect(fields).toContain('(Empfehlung der Kanzlei)');
    expect(fields).toContain('Nicht vorausgewählt – Sie entscheiden durch aktives Anklicken.');
    expect(wizard).toContain('consentForNewDeclaration()');
  });

  it('zeigt den unnötigen Kanzlei-Verwaltungshinweis im Portal nicht mehr', () => {
    const fields = read('components/consent-fields.tsx');

    expect(fields).not.toContain(
      'Empfänger, Kommunikationsdetails und Spezialdienstleister werden zentral',
    );
  });

  it('erzwingt Pflichtoptionen im öffentlichen Onboarding auch serverseitig', () => {
    const transaction = read('server/gwg-onboarding/submission-transaction.ts');
    const page = read('app/gwg-onboarding/page.tsx');
    const wizard = read('app/gwg-onboarding/wizard.tsx');

    expect(transaction).toContain('enforceRequired: true');
    expect(transaction).toContain('expectedDisplay:');
    expect(transaction).toContain('await lockConsentCatalogTx(tx, input.invite.tenantId)');
    expect(transaction).toContain('noticeSnapshot: notice.body');
    expect(page).toContain('consentDisplayRevision(notice, visibleOptions)');
    expect(wizard).toContain('displayRevision: consentDisplayRevision');
    expect(wizard).toContain('missingRequiredConsentOptions(consent, consentOptions)');
  });

  it('hält den exklusiven Tenant-Lock nur im finalen Display-CAS-Fenster', () => {
    const transaction = read('server/gwg-onboarding/submission-transaction.ts');
    const scriptAt = transaction.indexOf(
      'export async function runOnboardingSubmissionTransactionTx',
    );
    const notifyAt = transaction.indexOf('await notifySubmissionTx(', scriptAt);
    const finalizationAt = transaction.indexOf(
      'await persistSubmissionConsentFinalizationTx(',
      notifyAt,
    );

    expect(notifyAt).toBeGreaterThan(-1);
    expect(finalizationAt).toBeGreaterThan(notifyAt);

    const finalizationStart = transaction.indexOf(
      'async function persistSubmissionConsentFinalizationTx',
    );
    const finalizationEnd = transaction.indexOf(
      '/**\n * The transaction body stays as a readable phase script.',
      finalizationStart,
    );
    const lockedWindow = transaction.slice(finalizationStart, finalizationEnd);
    expect(lockedWindow).toContain('await lockConsentCatalogTx(tx, input.invite.tenantId)');
    expect(lockedWindow).toContain('renderNoticeForTenantTx');
    expect(lockedWindow).toContain('resolveConsentSelectionsTx');
    expect(lockedWindow).toContain('tx.clientConsent.create');
    expect(lockedWindow).not.toContain('tx.gwg');
    expect(lockedWindow).not.toContain('notifyMany');
  });

  it('benennt die Datenschutz-Zentrale neutral für Auswahl und Bestätigungen', () => {
    const page = read('app/staff/(protected)/admin/privacy/page.tsx');

    expect(page).toContain('Datenschutz-Auswahl und Bestätigungen');
    expect(page).toContain('Hinweise &amp; Datenschutz-Auswahl');
    expect(page).not.toContain('Kanzlei-Hinweise, freiwillige Einwilligungen');
  });

  it('unterscheidet im Portal aktive Auswahlen von widerrufbaren Einwilligungen', () => {
    const page = read('app/portal/(protected)/settings/page.tsx');
    const staffPage = read('app/staff/(protected)/clients/[id]/privacy/page.tsx');

    expect(page).toContain('aktive Auswahl dokumentiert');
    expect(page).toContain('Widerrufbare Auswahl zurückziehen');
    expect(page).toContain('countRevocableGranted');
    expect(page).toContain('revocableConsentCount > 0 && !canSelfRevoke');
    expect(staffPage).toContain('countRevocableGranted');
    expect(staffPage).toContain('revocableConsentCount > 0');
    expect(page).toMatch(/Rechtlich\s+notwendige Bestätigungen bleiben als Nachweis/);
    expect(page).not.toContain('freiwillige Einzeleinwilligung(en)');
    expect(page).not.toContain('Alle freiwilligen Einwilligungen widerrufen');
  });
});
