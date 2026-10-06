// Quantenlos-Panel: Verdrahtung der Hooks mit den Server-Actions
// (TCMS-SAMPLE-PROOF-001) — Payloads, Router-Refresh und Abschluss eines
// offenen Starts. Der statische Render liefert die Handler des
// Anfangszustands; die Transition wird hier synchron ausgeführt.

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LosStart, LosZiehung } from '@/server/risk';

const harness = vi.hoisted(() => ({ log: [] as string[], pending: [] as Promise<unknown>[] }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useTransition: () => [
      false,
      (callback: () => unknown) => {
        harness.log.push('transition');
        harness.pending.push(Promise.resolve(callback()));
      },
    ],
  };
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => harness.log.push('refresh') }),
}));
const actions = vi.hoisted(() => ({
  rahmenVorschauAction: vi.fn(),
  losZiehenAction: vi.fn(),
  losAbholenAction: vi.fn(),
  losStartWiederaufnehmenAction: vi.fn(),
  losStartFreigebenAction: vi.fn(),
  losPruefenAction: vi.fn(),
  ibmTokenSpeichernAction: vi.fn(),
  ibmTokenEntfernenAction: vi.fn(),
}));
vi.mock('../actions', () => actions);

import { useIbmToken, useLosRecovery, useLosZiehung } from '../quantenlos-hooks';

function probe<T>(useHook: () => T): T {
  let value: T | undefined;
  function Probe() {
    value = useHook();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return value!;
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.all(harness.pending);
}

function respond(name: keyof typeof actions, result: unknown) {
  actions[name].mockImplementation(async (...args: unknown[]) => {
    harness.log.push(`${name}:${JSON.stringify(args)}`);
    return result;
  });
}

const START: LosStart = {
  attemptId: '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a',
  backend: 'qpu',
  k: 2,
  rahmen: ['x', 'y'],
  rahmenTyp: 'subsumtion',
  zeitraum: { von: '2026-09-01', bis: '2026-09-30' },
  beantragtAm: '2026-10-05T07:00:00.000Z',
  beantragtVon: 'staff-1',
};

const INITIAL = {
  initialZeitraum: { von: '2026-09-01', bis: '2026-09-30' },
  initialN: 5,
  initialPending: null,
  initialStart: null,
  initialZiehungen: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  harness.log = [];
  harness.pending = [];
});

describe('Quantenlos — Ziehungs-Hook', () => {
  it('aktualisiert nur nach einer fehlgeschlagenen Ziehung den Server-Stand', async () => {
    respond('losZiehenAction', { ok: false, error: 'Engine.' });
    probe(() => useLosZiehung(INITIAL)).ziehen();
    await settle();
    respond('losZiehenAction', { ok: true, ergebnis: { status: 'wartet', pending: {} } });
    probe(() => useLosZiehung(INITIAL)).ziehen();
    await settle();
    const payload = JSON.stringify([
      { von: '2026-09-01', bis: '2026-09-30', k: 3, backend: 'qpu', rahmenTyp: 'subsumtion' },
    ]);
    expect(harness.log).toEqual([
      'transition',
      `losZiehenAction:${payload}`,
      'refresh',
      'transition',
      `losZiehenAction:${payload}`,
    ]);
  });

  it('fragt die Rahmen-Vorschau mit dem geänderten Feld ab', async () => {
    respond('rahmenVorschauAction', { ok: true, n: 1 });
    const hook = probe(() => useLosZiehung(INITIAL));
    hook.setzeVon('2026-10-01');
    hook.setzeBis('2026-10-31');
    hook.setzeRahmenTyp('audit');
    await settle();
    expect(harness.log).toEqual([
      'transition',
      'rahmenVorschauAction:[{"von":"2026-10-01","bis":"2026-09-30","rahmenTyp":"subsumtion"}]',
      'transition',
      'rahmenVorschauAction:[{"von":"2026-09-01","bis":"2026-10-31","rahmenTyp":"subsumtion"}]',
      'transition',
      'rahmenVorschauAction:[{"von":"2026-09-01","bis":"2026-09-30","rahmenTyp":"audit"}]',
    ]);
  });

  it('holt ab und prüft Nachweise online nur mit IBM-Job', async () => {
    respond('losAbholenAction', { ok: false });
    respond('losPruefenAction', { ok: true });
    const hook = probe(() => useLosZiehung(INITIAL));
    hook.abholen();
    hook.pruefen({ auditId: '901', jobId: 'job-qpu' } as LosZiehung);
    hook.pruefen({ auditId: '900', jobId: null } as LosZiehung);
    await settle();
    expect(harness.log).toEqual([
      'transition',
      'losAbholenAction:[]',
      'transition',
      'losPruefenAction:[{"auditId":"901","online":true}]',
      'transition',
      'losPruefenAction:[{"auditId":"900","online":false}]',
    ]);
  });
});

describe('Quantenlos — IBM-Zugang-Hook', () => {
  it('speichert die Eingabe und entfernt den Token über eigene Aktionen', async () => {
    respond('ibmTokenSpeichernAction', { ok: false });
    respond('ibmTokenEntfernenAction', { ok: true });
    const hook = probe(() => useIbmToken({ hinterlegt: true, suffix: 'wxyz', gesetztAm: null }));
    expect(hook).toMatchObject({ tokenEingabe: '', tokenFehler: null, tokenBusy: false });
    hook.tokenSpeichern();
    hook.tokenEntfernen();
    await settle();
    expect(harness.log).toEqual([
      'transition',
      'ibmTokenSpeichernAction:[{"token":""}]',
      'transition',
      'ibmTokenEntfernenAction:[]',
    ]);
  });
});

describe('Quantenlos — Klärung offener Starts (TCMS-SAMPLE-PROOF-001)', () => {
  it('gibt eine bestätigte Nichtausführung frei und schließt den Start ab', async () => {
    respond('losStartFreigebenAction', { ok: true });
    const onResolved = vi.fn((...args: unknown[]) => harness.log.push(`resolved:${args.length}`));
    probe(() => useLosRecovery(START, onResolved)).recoverStart(true);
    await settle();
    expect(harness.log).toEqual([
      'transition',
      `losStartFreigebenAction:${JSON.stringify([
        { attemptId: START.attemptId, reason: '', confirmedNotExecuted: false },
      ])}`,
      'resolved:0',
      'refresh',
    ]);
  });

  it('übernimmt eine wiederaufgenommene Ziehung, aber nicht ohne Ergebnis', async () => {
    const ergebnis = { status: 'wartet', pending: { jobId: 'job-1' } };
    const onResolved = vi.fn((value?: unknown) =>
      harness.log.push(`resolved:${value === ergebnis}`),
    );
    respond('losStartWiederaufnehmenAction', { ok: true });
    probe(() => useLosRecovery(START, onResolved)).recoverStart(false);
    await settle();
    respond('losStartWiederaufnehmenAction', { ok: true, ergebnis });
    probe(() => useLosRecovery(START, onResolved)).recoverStart(false);
    await settle();
    const payload = JSON.stringify([{ attemptId: START.attemptId, jobId: '', proofJson: '' }]);
    expect(harness.log).toEqual([
      'transition',
      `losStartWiederaufnehmenAction:${payload}`,
      'transition',
      `losStartWiederaufnehmenAction:${payload}`,
      'resolved:true',
      'refresh',
    ]);
  });

  it('bleibt ohne offenen Start und bei abgelehnter Freigabe untätig', async () => {
    respond('losStartFreigebenAction', { ok: false, error: 'Antwort gesichert.' });
    const onResolved = vi.fn();
    probe(() => useLosRecovery(null, onResolved)).recoverStart(true);
    probe(() => useLosRecovery(START, onResolved)).recoverStart(true);
    await settle();
    expect(onResolved).not.toHaveBeenCalled();
    expect(harness.log).toEqual([
      'transition',
      `losStartFreigebenAction:${JSON.stringify([
        { attemptId: START.attemptId, reason: '', confirmedNotExecuted: false },
      ])}`,
    ]);
  });
});
