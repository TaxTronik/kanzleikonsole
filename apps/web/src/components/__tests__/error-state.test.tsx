import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Kein DOM in der Testumgebung: Der Test fängt die Props des gerenderten
// <button> ab und ruft dessen onClick direkt auf. useTransition wird so
// ersetzt, dass sichtbar ist, welche Aufrufe innerhalb der Transition liegen.
const probe = vi.hoisted(() => ({
  calls: [] as string[],
  inTransition: false,
  buttons: [] as Array<Record<string, unknown>>,
}));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useTransition: () =>
      [
        false,
        (callback: () => void) => {
          probe.inTransition = true;
          try {
            callback();
          } finally {
            probe.inTransition = false;
          }
        },
      ] as const,
  };
});

for (const runtime of ['react/jsx-runtime', 'react/jsx-dev-runtime']) {
  vi.doMock(runtime, async () => {
    const original =
      await vi.importActual<Record<string, (...args: unknown[]) => unknown>>(runtime);
    const capture =
      (factory: (...args: unknown[]) => unknown) =>
      (type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
        if (type === 'button') probe.buttons.push(props);
        return factory(type, props, ...rest);
      };
    return {
      ...original,
      ...(original.jsx ? { jsx: capture(original.jsx), jsxs: capture(original.jsxs!) } : {}),
      ...(original.jsxDEV ? { jsxDEV: capture(original.jsxDEV) } : {}),
    };
  });
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: () => probe.calls.push(`refresh:${probe.inTransition ? 'transition' : 'sync'}`),
  }),
}));

const { ErrorState } = await import('../error-state');

beforeEach(() => {
  probe.calls = [];
  probe.buttons = [];
});

function render(props: Partial<Parameters<typeof ErrorState>[0]> = {}) {
  const error = Object.assign(new Error('Pool-Timeout'), { digest: 'abc123' });
  const reset = vi.fn(() =>
    probe.calls.push(`reset:${probe.inTransition ? 'transition' : 'sync'}`),
  );
  const html = renderToStaticMarkup(
    <ErrorState error={error} reset={reset} title="Seite konnte nicht geladen werden" {...props} />,
  );
  return { html, reset };
}

describe('ErrorState (gemeinsame Fehleranzeige, F-16)', () => {
  it('lädt beim erneuten Versuch die Serverdaten neu und setzt die Grenze zurück — in einer Transition', () => {
    const { reset } = render();
    expect(probe.calls).toEqual([]);
    expect(probe.buttons).toHaveLength(1);
    (probe.buttons[0]!.onClick as () => void)();
    expect(probe.calls).toEqual(['refresh:transition', 'reset:transition']);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('zeigt Titel, Hinweis und Fehler-Code auf Deutsch', () => {
    const { html } = render({ contactHint: 'wenden Sie sich an den Support.' });
    expect(html).toContain(
      '<h2 class="text-lg font-semibold text-primary mb-2">Seite konnte nicht geladen werden</h2>',
    );
    expect(html).toContain(
      'Ein unerwarteter Fehler ist aufgetreten. Bitte versuchen Sie es erneut — wenden Sie sich an den Support.',
    );
    expect(html).toContain('Fehler-Code: abc123');
    expect(html).toContain('Erneut versuchen');
    expect(html).toContain('min-h-[50vh]');
  });

  it('beendet den Satz ohne Kontakthinweis mit einem Punkt und füllt als Seite den Viewport', () => {
    const { html } = render({ layout: 'page' });
    expect(html).toContain('Bitte versuchen Sie es erneut.');
    expect(html).toContain('min-h-[60vh]');
  });
});
