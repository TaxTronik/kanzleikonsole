// Quantenlos-Panel: reine Reducer, Sperr-/Freigabebedingungen, Aktionspayloads
// und Meldungen (TCMS-SAMPLE-PROOF-001). Die Erwartungen entsprechen dem
// Verhalten vor der Aufteilung (K-04).

import { describe, expect, it } from 'vitest';
import type { LosStart, LosZiehung, PendingLos } from '@/server/risk';
import {
  createIbmTokenState,
  createLosPanelState,
  createLosRecoveryState,
  freigabeFehler,
  freigabeInput,
  freigabeMoeglich,
  gespeicherteEngineAntwort,
  ibmTokenReducer,
  jobAbholbar,
  losPanelReducer,
  losRecoveryReducer,
  nachweisUebernehmbar,
  normalisiereK,
  pruefInput,
  tokenSpeicherbar,
  wiederaufnahmeFehler,
  wiederaufnahmeInput,
  ziehungGesperrt,
  ziehungInput,
  type LosPanelState,
} from '../quantenlos-state';

function ziehung(auditId: string, overrides: Partial<LosZiehung> = {}): LosZiehung {
  return {
    auditId,
    rahmenTyp: 'subsumtion',
    gezogenAm: '2026-10-01T08:00:00.000Z',
    zeitraum: { von: '2026-09-01', bis: '2026-09-30' },
    backend: 'csprng',
    quelleKlasse: 'csprng',
    jobId: null,
    commitment: 'c'.repeat(64),
    n: 5,
    k: 2,
    stichprobe: [],
    nachschau: [],
    rohCountsSha256: null,
    extraktor: 'none',
    drbg: 'os',
    hinweise: [],
    ...overrides,
  };
}

const PENDING: PendingLos = {
  jobId: 'job-1',
  backend: 'qpu',
  commitment: 'f'.repeat(64),
  k: 2,
  rahmen: ['a', 'b', 'c'],
  rahmenTyp: 'subsumtion',
  zeitraum: { von: '2026-09-01', bis: '2026-09-30' },
  beantragtAm: '2026-10-05T07:00:00.000Z',
  beantragtVon: 'staff-1',
};

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

function panel(overrides: Partial<LosPanelState> = {}): LosPanelState {
  return {
    ...createLosPanelState({
      initialZeitraum: { von: '2026-09-01', bis: '2026-09-30' },
      initialN: 5,
      initialPending: null,
      initialStart: null,
      initialZiehungen: [ziehung('900')],
    }),
    ...overrides,
  };
}

describe('Quantenlos — Ziehungs-Reducer (TCMS-SAMPLE-PROOF-001)', () => {
  it('startet mit Subsumtionsrahmen, QPU und k = min(3, n), mindestens 1', () => {
    expect(panel()).toMatchObject({
      von: '2026-09-01',
      bis: '2026-09-30',
      rahmenTyp: 'subsumtion',
      n: 5,
      k: 3,
      backend: 'qpu',
      neueste: null,
      fehler: null,
      queueHinweis: null,
      pruefErgebnisse: {},
      pruefBusy: null,
    });
    const leer = createLosPanelState({
      initialZeitraum: { von: '2026-09-01', bis: '2026-09-30' },
      initialN: 0,
      initialPending: PENDING,
      initialStart: START,
      initialZiehungen: [],
    });
    expect(leer).toMatchObject({ n: 0, k: 1, pending: PENDING, openStart: START });
  });

  it('ermittelt den Rahmen nach jeder Änderung neu und meldet Vorschaufehler', () => {
    const geaendert = losPanelReducer(panel({ fehler: 'alt' }), {
      type: 'rahmen',
      von: '2026-10-01',
      bis: '2026-10-31',
      rahmenTyp: 'audit',
    });
    expect(geaendert).toMatchObject({
      von: '2026-10-01',
      bis: '2026-10-31',
      rahmenTyp: 'audit',
      n: null,
      fehler: 'alt',
    });
    // Erfolg setzt n, lässt eine frühere Meldung aber stehen (wie bisher).
    expect(
      losPanelReducer(geaendert, { type: 'vorschau', result: { ok: true, n: 1 } }),
    ).toMatchObject({ n: 1, fehler: 'alt' });
    expect(losPanelReducer(geaendert, { type: 'vorschau', result: { ok: true } })).toMatchObject({
      n: null,
      fehler: null,
    });
    expect(losPanelReducer(geaendert, { type: 'vorschau', result: { ok: false } }).fehler).toBe(
      'Rahmen-Vorschau fehlgeschlagen.',
    );
    expect(
      losPanelReducer(geaendert, { type: 'vorschau', result: { ok: false, error: 'Zeitraum.' } })
        .fehler,
    ).toBe('Zeitraum.');
  });

  it('normalisiert k und sperrt Ziehungen bei offenem Auftrag, leerem Rahmen oder k > n', () => {
    expect(normalisiereK('7')).toBe(7);
    expect(normalisiereK('0')).toBe(1);
    expect(normalisiereK('')).toBe(1);
    expect(normalisiereK('-4')).toBe(1);
    expect(losPanelReducer(panel(), { type: 'k', value: '0' }).k).toBe(1);

    expect(ziehungGesperrt(panel())).toBe(false);
    expect(ziehungGesperrt(panel({ pending: PENDING }))).toBe(true);
    expect(ziehungGesperrt(panel({ openStart: START }))).toBe(true);
    expect(ziehungGesperrt(panel({ n: null }))).toBe(true);
    expect(ziehungGesperrt(panel({ n: 0 }))).toBe(true);
    expect(ziehungGesperrt(panel({ n: 5, k: 6 }))).toBe(true);
    expect(ziehungGesperrt(panel({ n: 5, k: 5 }))).toBe(false);
  });

  it('übergibt Ziehung und Prüfung in unveränderter Feldreihenfolge', () => {
    const state = losPanelReducer(panel({ k: 2 }), { type: 'backend', backend: 'simulator' });
    const input = ziehungInput(state);
    expect(Object.keys(input)).toEqual(['von', 'bis', 'k', 'backend', 'rahmenTyp']);
    expect(input).toEqual({
      von: '2026-09-01',
      bis: '2026-09-30',
      k: 2,
      backend: 'simulator',
      rahmenTyp: 'subsumtion',
    });
    expect(pruefInput(ziehung('901', { jobId: 'job-qpu' }))).toEqual({
      auditId: '901',
      online: true,
    });
    expect(pruefInput(ziehung('900'))).toEqual({ auditId: '900', online: false });
  });

  it('übernimmt wartende und fertige Ziehungen und meldet Fehler', () => {
    const gestartet = losPanelReducer(panel({ fehler: 'alt', queueHinweis: 'alt' }), {
      type: 'ziehung-gestartet',
    });
    expect(gestartet).toMatchObject({ fehler: null, queueHinweis: null });

    expect(losPanelReducer(gestartet, { type: 'gezogen', result: { ok: false } }).fehler).toBe(
      'Ziehung fehlgeschlagen.',
    );
    expect(losPanelReducer(gestartet, { type: 'gezogen', result: { ok: true } }).fehler).toBe(
      'Ziehung fehlgeschlagen.',
    );
    expect(
      losPanelReducer(gestartet, { type: 'gezogen', result: { ok: false, error: 'Engine.' } })
        .fehler,
    ).toBe('Engine.');

    const wartet = losPanelReducer(gestartet, {
      type: 'gezogen',
      result: { ok: true, ergebnis: { status: 'wartet', pending: PENDING } },
    });
    expect(wartet).toMatchObject({
      pending: PENDING,
      queueHinweis: 'Der QPU-Job ist eingereiht — Ergebnis später über „Abholen" holen.',
    });

    const fertig = losPanelReducer(gestartet, {
      type: 'gezogen',
      result: { ok: true, ergebnis: { status: 'fertig', ziehung: ziehung('902') } },
    });
    expect(fertig.ziehungen.map((z) => z.auditId)).toEqual(['902', '900']);
    expect(fertig).toMatchObject({ neueste: '902', pending: null });
  });

  it('hält wartende Jobs beim Abholen fest und übernimmt fertige', () => {
    const state = panel({ pending: PENDING });
    expect(
      losPanelReducer(state, {
        type: 'abgeholt',
        result: { ok: true, ergebnis: { status: 'wartet', pending: PENDING } },
      }),
    ).toMatchObject({
      pending: PENDING,
      queueHinweis: 'Der Job liegt noch in der IBM-Queue — bitte später erneut abholen.',
    });
    expect(losPanelReducer(state, { type: 'abgeholt', result: { ok: true } }).fehler).toBe(
      'Abholen fehlgeschlagen.',
    );
    expect(
      losPanelReducer(state, { type: 'abgeholt', result: { ok: false, error: 'IBM.' } }).fehler,
    ).toBe('IBM.');
    const fertig = losPanelReducer(state, {
      type: 'abgeholt',
      result: { ok: true, ergebnis: { status: 'fertig', ziehung: ziehung('903') } },
    });
    expect(fertig).toMatchObject({ pending: null, neueste: '903' });
  });

  it('merkt Prüfergebnisse je Ziehung und meldet Prüffehler', () => {
    const laeuft = losPanelReducer(panel(), { type: 'pruefung-gestartet', auditId: '900' });
    expect(laeuft.pruefBusy).toBe('900');
    const ergebnis = { gueltig: true, geprueft: ['commitment'], hinweise: [] };
    expect(
      losPanelReducer(laeuft, { type: 'geprueft', auditId: '900', result: { ok: true, ergebnis } }),
    ).toMatchObject({ pruefErgebnisse: { '900': ergebnis }, pruefBusy: null, fehler: null });
    expect(
      losPanelReducer(laeuft, { type: 'geprueft', auditId: '900', result: { ok: false } }),
    ).toMatchObject({ fehler: 'Prüfung fehlgeschlagen.', pruefBusy: null });
    expect(
      losPanelReducer(laeuft, { type: 'geprueft', auditId: '900', result: { ok: true } }),
    ).toEqual({ ...laeuft, pruefBusy: null });
  });

  it('schließt einen geklärten Start ab, ohne ihn als neueste Ziehung zu markieren', () => {
    const offen = panel({ openStart: START });
    expect(losPanelReducer(offen, { type: 'start-geklaert' })).toEqual({
      ...offen,
      openStart: null,
    });
    expect(
      losPanelReducer(offen, {
        type: 'start-geklaert',
        result: { status: 'wartet', pending: PENDING },
      }),
    ).toMatchObject({ openStart: null, pending: PENDING });
    const fertig = losPanelReducer(offen, {
      type: 'start-geklaert',
      result: { status: 'fertig', ziehung: ziehung('904') },
    });
    expect(fertig.ziehungen.map((z) => z.auditId)).toEqual(['904', '900']);
    expect(fertig.neueste).toBeNull();
  });
});

describe('Quantenlos — IBM-Zugang', () => {
  const status = { hinterlegt: false, suffix: null, gesetztAm: null };
  const gesetzt = { hinterlegt: true, suffix: 'wxyz', gesetztAm: '2026-10-06T09:00:00.000Z' };

  it('speichert erst ab acht Zeichen und leert die Eingabe nach Erfolg', () => {
    expect(tokenSpeicherbar('  1234567  ')).toBe(false);
    expect(tokenSpeicherbar('12345678')).toBe(true);
    let state = ibmTokenReducer(createIbmTokenState(status), {
      type: 'eingabe',
      value: 'token-123456789',
    });
    state = ibmTokenReducer({ ...state, fehler: 'alt' }, { type: 'gestartet' });
    expect(state.fehler).toBeNull();
    expect(ibmTokenReducer(state, { type: 'gespeichert', result: { ok: true } })).toBe(state);
    expect(ibmTokenReducer(state, { type: 'gespeichert', result: { ok: false } }).fehler).toBe(
      'Speichern fehlgeschlagen.',
    );
    expect(
      ibmTokenReducer(state, { type: 'gespeichert', result: { ok: true, status: gesetzt } }),
    ).toEqual({ status: gesetzt, eingabe: '', fehler: null });
  });

  it('entfernt den Token und meldet Fehler', () => {
    const state = createIbmTokenState(gesetzt);
    expect(ibmTokenReducer(state, { type: 'entfernt', result: { ok: false } }).fehler).toBe(
      'Entfernen fehlgeschlagen.',
    );
    expect(
      ibmTokenReducer(state, { type: 'entfernt', result: { ok: false, error: 'Rolle.' } }).fehler,
    ).toBe('Rolle.');
    expect(ibmTokenReducer(state, { type: 'entfernt', result: { ok: true, status } })).toEqual({
      status,
      eingabe: '',
      fehler: null,
    });
  });
});

describe('Quantenlos — Klärung offener Starts (TCMS-SAMPLE-PROOF-001)', () => {
  it('lädt eine gesicherte Engine-Antwort nur zur Prüfung in die Felder', () => {
    expect(gespeicherteEngineAntwort(null)).toEqual({ jobId: '', proof: '' });
    expect(gespeicherteEngineAntwort(START)).toEqual({ jobId: '', proof: '' });
    const gesichert = gespeicherteEngineAntwort({
      ...START,
      engineResponse: { job_id: 'job-saved', nachweis: { commitment: 'abc' } },
    });
    expect(gesichert).toEqual({
      jobId: 'job-saved',
      proof: JSON.stringify({ commitment: 'abc' }, null, 2),
    });
    expect(gespeicherteEngineAntwort({ ...START, engineResponse: { job_id: 42 } }).jobId).toBe('');
    const state = losRecoveryReducer(createLosRecoveryState(), {
      type: 'gespeicherte-antwort',
      ...gesichert,
    });
    expect(state).toMatchObject({ jobId: 'job-saved', proof: gesichert.proof });
  });

  it('erlaubt Job-Abholung und Nachweisübernahme nur einzeln', () => {
    const leer = createLosRecoveryState();
    expect(jobAbholbar(leer)).toBe(false);
    expect(nachweisUebernehmbar(leer)).toBe(false);
    const job = losRecoveryReducer(leer, { type: 'job-id', value: ' job-1 ' });
    expect(jobAbholbar(job)).toBe(true);
    expect(nachweisUebernehmbar(job)).toBe(false);
    const beides = losRecoveryReducer(job, { type: 'nachweis', value: '{}' });
    expect(jobAbholbar(beides)).toBe(false);
    expect(nachweisUebernehmbar(beides)).toBe(false);
    const nachweis = losRecoveryReducer(beides, { type: 'job-id', value: '  ' });
    expect(nachweisUebernehmbar(nachweis)).toBe(true);
  });

  it('gibt nur nach bestätigter Nichtausführung mit mindestens 30 Zeichen Begründung frei', () => {
    const begruendung = 'Betreiber bestätigt: nie angenommen';
    expect(begruendung.length).toBeGreaterThanOrEqual(30);
    let state = losRecoveryReducer(createLosRecoveryState(), {
      type: 'begruendung',
      value: begruendung,
    });
    expect(freigabeMoeglich(state)).toBe(false);
    state = losRecoveryReducer(state, { type: 'bestaetigt', value: true });
    expect(freigabeMoeglich(state)).toBe(true);
    expect(freigabeMoeglich({ ...state, releaseReason: `  ${'x'.repeat(29)}   ` })).toBe(false);
  });

  it('bindet beide Klärungswege an den reservierten Versuch', () => {
    const state = {
      ...createLosRecoveryState(),
      jobId: 'job-1',
      proof: '',
      releaseReason: 'Begründung',
      confirmedNotExecuted: true,
    };
    const freigabe = freigabeInput(START, state);
    expect(Object.keys(freigabe)).toEqual(['attemptId', 'reason', 'confirmedNotExecuted']);
    expect(freigabe).toEqual({
      attemptId: START.attemptId,
      reason: 'Begründung',
      confirmedNotExecuted: true,
    });
    const wiederaufnahme = wiederaufnahmeInput(START, state);
    expect(Object.keys(wiederaufnahme)).toEqual(['attemptId', 'jobId', 'proofJson']);
    expect(wiederaufnahme).toEqual({ attemptId: START.attemptId, jobId: 'job-1', proofJson: '' });
  });

  it('meldet Fehler wie bisher', () => {
    expect(freigabeFehler({ ok: false })).toBe('Freigabe fehlgeschlagen.');
    expect(freigabeFehler({ ok: false, error: 'Antwort gesichert.' })).toBe('Antwort gesichert.');
    expect(wiederaufnahmeFehler({ ok: true })).toBe('Wiederaufnahme fehlgeschlagen.');
    expect(wiederaufnahmeFehler({ ok: false })).toBe('Wiederaufnahme fehlgeschlagen.');
    expect(wiederaufnahmeFehler({ ok: false, error: 'Fremder Job.' })).toBe('Fremder Job.');
    let state = losRecoveryReducer(createLosRecoveryState(), {
      type: 'fehlgeschlagen',
      fehler: 'X',
    });
    expect(state.fehler).toBe('X');
    state = losRecoveryReducer(state, { type: 'gestartet' });
    expect(state.fehler).toBeNull();
  });
});
