import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODULES } from '@/server/settings/modules';
import { resolveClientNavigation } from '@/lib/navigation-registry';

const poaRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = resolve(poaRoot, '..', '..', '..', '..');
const readPoa = (relative: string) => readFileSync(resolve(poaRoot, relative), 'utf8');
const readSrc = (relative: string) => readFileSync(resolve(srcRoot, relative), 'utf8');

describe('Vollmachten im Mandantenkontext', () => {
  it('übernimmt den Mandanten aus dem Onboarding in das Anlageformular', () => {
    const onboarding = readSrc('app/staff/(protected)/clients/onboarding/[id]/page.tsx');
    const page = readPoa('new/page.tsx');
    const form = readPoa('new/form.tsx');

    expect(onboarding).toContain('/staff/poa/new?clientId=${clientId}&from=onboarding');
    // Nur der angeforderte Mandant wird geladen — auch vor der Aktivierung,
    // aber nie beendet/anonymisiert und nur mit Mandantenzugriff.
    expect(page).toContain('canAccessClientTx(tx, session, requestedClientId)');
    expect(page).toContain(
      'where: { id: requestedClientId, anonymizedAt: null, mandateEndedAt: null }',
    );
    expect(page).toContain('resolveInitialPoaClientId(');
    expect(page).toContain('initialClient={initialClient}');
    expect(page).toContain('returnContext={onboardingClientId ? returnContext : undefined}');
    expect(page).not.toContain('tx.client.findMany(');
    expect(form).toContain('<ClientCombobox');
    expect(form).toContain('loadPoaSignerContactsAction(next.id)');
    expect(form).toContain('name="returnContext"');
    expect(form).toContain('locked={Boolean(pendingDocumentId || returnContext)}');
    expect(form).toContain('poaCreateResumeHref({');
  });

  it('öffnet vom Mandanten aus eine vollständig gefilterte Vollmachtenliste', () => {
    const clientPage = readSrc('app/staff/(protected)/clients/[id]/page.tsx');
    const listPage = readPoa('page.tsx');

    // Der Reiter kommt aus der Modul-Registry (sichtbar nur bei aktivem Vollmachtenmodul).
    expect(clientPage).toContain('href={clientNav.poa}');
    expect(
      resolveClientNavigation({ ...DEFAULT_MODULES, poaMode: 'MARKDOWN_OTP' }, 'client-1').poa,
    ).toBe('/staff/poa?clientId=client-1');
    expect(resolveClientNavigation({ ...DEFAULT_MODULES, poaMode: 'OFF' }, 'client-1').poa).toBe(
      undefined,
    );
    expect(listPage).toContain('where: clientId');
    expect(listPage).toContain('take: clientId ? undefined : 200');
    expect(listPage).toContain('`Alle Vollmachten für ${filteredClient.name}`');
  });
});
