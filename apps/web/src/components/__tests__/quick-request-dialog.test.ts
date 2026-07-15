import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative: string) => readFileSync(resolve(srcRoot, relative), 'utf8');

describe('Quick-Anforderungsdialog', () => {
  it('öffnet einen barrierearmen Dialog und sendet beim Öffnen noch nichts', () => {
    const source = read('components/quick-request-dialog.tsx');

    expect(source).toContain('aria-haspopup="dialog"');
    expect(source).toContain('<Modal title="Anforderung erstellen"');
    expect(source).toContain('mode="quick"');
    expect(source).toContain('if (!pending) setOpen(false)');
  });

  it('verlangt die bestätigte Formulareingabe und sperrt während Pending', () => {
    const source = read('app/staff/(protected)/clients/[id]/requests/new/form.tsx');

    expect(source).toContain("mode === 'quick' ? createQuickRequestAction : createRequestAction");
    expect(source).toContain('Mandant suchen');
    expect(source).toContain('role="combobox"');
    expect(source).toContain('searchRequestClientsAction(clientSearch)');
    expect(source).toContain('Noch nicht auswählbar: GwG-Prüfung ausstehend');
    expect(source).toContain('name="clientId"');
    expect(source).toContain('name="requestId"');
    expect(source).toContain('name="title"');
    expect(source).toContain('name="description"');
    expect(source).toContain('name="priority"');
    expect(source).toContain('name="dueAt"');
    expect(source).toContain('disabled={isPending || disabled || !selectedClientId}');
  });

  it('bindet den Dialog direkt an Anforderungen, Mandanten und Onboarding ein', () => {
    const overview = read('app/staff/(protected)/requests/page.tsx');
    const clientsPage = read('app/staff/(protected)/clients/page.tsx');
    const clientPage = read('app/staff/(protected)/clients/[id]/page.tsx');
    const onboarding = read('app/staff/(protected)/clients/onboarding/[id]/page.tsx');

    expect(overview).toContain('<QuickRequestDialog');
    expect(clientsPage).toContain('<QuickRequestDialog');
    expect(clientPage).toContain('<QuickRequestDialog');
    expect(clientPage).toContain('allowActive: client.allowActive');
    expect(clientPage).not.toContain('href={`/staff/clients/${client.id}/requests/new`}');
    expect(onboarding).toContain('<QuickRequestDialog');
    expect(onboarding).not.toContain('requests/new?from=onboarding');
  });
});
