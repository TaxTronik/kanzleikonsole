import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function read(relativePath: string): string {
  return readFileSync(resolve(webRoot, relativePath), 'utf8');
}

describe('Einwilligungsrichtlinien in der UI', () => {
  it('bietet Pflichtoptionen und ungekreuzte Empfehlungen mit klaren Grenzen im ACP an', () => {
    const editor = read('app/staff/(protected)/admin/privacy/consent-options-editor.tsx');

    expect(editor).toContain('Pflicht im Portal');
    expect(editor).toContain('Als Empfehlung hervorheben');
    expect(editor).toContain('Bleibt im Portal ungekreuzt');
    expect(editor).toContain('niemals für freiwillige Werbung oder Newsletter');
    expect(editor).toContain("option.section === 'OTHER'");
    expect(editor).not.toContain('defaultSelected');
    expect(editor).toContain('version: 2');
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
