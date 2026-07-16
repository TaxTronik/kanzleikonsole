import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
    expect(page).toContain('...(requestedClientId ? [{ id: requestedClientId }] : [])');
    expect(page).toContain('resolveInitialPoaClientId(');
    expect(page).toContain('initialClientId={initialClientId}');
    expect(page).toContain('returnContext={onboardingClientId ? returnContext : undefined}');
    expect(form).toContain('clients.some((client) => client.id === initialClientId)');
    expect(form).toContain('name="returnContext"');
    expect(form).toContain('disabled={Boolean(pendingDocumentId || returnContext)}');
    expect(form).toContain('poaCreateResumeHref({');
  });

  it('öffnet vom Mandanten aus eine vollständig gefilterte Vollmachtenliste', () => {
    const clientPage = readSrc('app/staff/(protected)/clients/[id]/page.tsx');
    const listPage = readPoa('page.tsx');

    expect(clientPage).toContain('href={`/staff/poa?clientId=${client.id}`}');
    expect(listPage).toContain('where: clientId');
    expect(listPage).toContain('take: clientId ? undefined : 200');
    expect(listPage).toContain('`Alle Vollmachten für ${filteredClient.name}`');
  });
});
