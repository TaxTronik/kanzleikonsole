import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AccessibleDisplayProvider,
  useAccessibleDisplayEnabled,
  useAccessibleDisplayReducedMotion,
} from '../accessible-display';
import { DEFAULT_DISPLAY_OPTIONS } from '@/lib/accessible-display-options';
import { CountUp, startCountUpAnimation } from '../count-up';

function animationFixture({ enabled = true, reduced = false, value = 100 } = {}) {
  let time = 1000;
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const values: number[] = [];
  const cancelled: number[] = [];
  const reducedMotion = {
    matches: reduced,
    addEventListener(_type: 'change', listener: (event: { matches: boolean }) => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: 'change', listener: (event: { matches: boolean }) => void) {
      listeners.delete(listener);
    },
  };
  const stop = startCountUpAnimation({
    value,
    enabled,
    reducedMotion,
    onValue: (next) => values.push(next),
    now: () => time,
    requestFrame: (callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelFrame: (frame) => {
      cancelled.push(frame);
      frames.delete(frame);
    },
  });
  return {
    values,
    frames,
    listeners,
    cancelled,
    stop,
    pendingFrame() {
      const callback = frames.values().next().value;
      if (!callback) throw new Error('Expected a pending animation frame');
      return callback;
    },
    advance(milliseconds: number) {
      time += milliseconds;
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(time);
    },
    setReducedMotion(matches: boolean) {
      reducedMotion.matches = matches;
      for (const listener of listeners) listener({ matches });
    },
  };
}

function PreferenceProbe() {
  return <span>{String(useAccessibleDisplayEnabled())}</span>;
}

function MotionProbe() {
  return <span>{String(useAccessibleDisplayReducedMotion())}</span>;
}

describe('persönliche Bewegungsreduktion beim Hochzählen', () => {
  it.each([false, true])('beachtet die individuelle Bewegungsoption (%s)', (reduceMotion) => {
    const html = renderToStaticMarkup(
      <AccessibleDisplayProvider
        initialEnabled
        initialOptions={{ ...DEFAULT_DISPLAY_OPTIONS, reduceMotion }}
        saveAction={async () => ({ ok: true })}
      >
        <MotionProbe />
      </AccessibleDisplayProvider>,
    );
    expect(html).toContain(`<span>${reduceMotion}</span>`);
  });
  it('verwendet ohne Profilprovider keine globale Anzeigeeinstellung', () => {
    expect(renderToStaticMarkup(<PreferenceProbe />)).toBe('<span>false</span>');
  });

  it.each([false, true])('liest den tatsächlichen Profil-Context (%s)', (enabled) => {
    const html = renderToStaticMarkup(
      <AccessibleDisplayProvider initialEnabled={enabled} saveAction={async () => ({ ok: true })}>
        <PreferenceProbe />
      </AccessibleDisplayProvider>,
    );
    expect(html).toContain(`<span>${enabled}</span>`);
  });

  it.each([0, 42, -8, 12.5])('rendert serverseitig unmittelbar den Endwert %s', (value) => {
    expect(renderToStaticMarkup(<CountUp value={value} />)).toBe(String(value));
  });

  it('rendert auch im gespeicherten barrierearmen Profil sofort den Endwert', () => {
    const html = renderToStaticMarkup(
      <AccessibleDisplayProvider initialEnabled saveAction={async () => ({ ok: true })}>
        <CountUp value={42} />
      </AccessibleDisplayProvider>,
    );
    expect(html).toMatch(/^<div class="contents" data-accessible-display="true"[^>]*>42<\/div>$/);
  });

  it.each([
    { enabled: false, reduced: false, value: 100 },
    { enabled: true, reduced: true, value: 100 },
    { enabled: false, reduced: false, value: 12.5 },
    { enabled: true, reduced: false, value: 0 },
  ])('startet ohne erlaubte Bewegung keine Frames: %j', (options) => {
    const fixture = animationFixture(options);
    expect(fixture.values).toEqual([options.value]);
    expect(fixture.frames.size).toBe(0);
    expect(fixture.listeners.size).toBe(0);
    fixture.stop();
    expect(fixture.cancelled).toEqual([]);
  });

  it('zählt bei erlaubter Bewegung mit ease-out in 600 ms bis zum exakten Endwert', () => {
    const fixture = animationFixture();
    expect(fixture.values).toEqual([0]);
    fixture.advance(300);
    expect(fixture.values).toEqual([0, 88]);
    expect(fixture.frames.size).toBe(1);
    fixture.advance(300);
    expect(fixture.values).toEqual([0, 88, 100]);
    expect(fixture.frames.size).toBe(0);
    expect(fixture.listeners.size).toBe(0);
  });

  it('bewahrt auch einen nicht ganzzahligen Endwert', () => {
    const fixture = animationFixture({ value: 12.5 });
    fixture.advance(600);
    expect(fixture.values.at(-1)).toBe(12.5);
  });

  it('bricht für neu aktivierte OS-Bewegungsreduktion sofort ab und zeigt den Endwert', () => {
    const fixture = animationFixture();
    fixture.advance(100);
    const queuedCallback = fixture.pendingFrame();
    fixture.setReducedMotion(true);
    expect(fixture.values.at(-1)).toBe(100);
    expect(fixture.cancelled).toHaveLength(1);
    expect(fixture.frames.size).toBe(0);
    expect(fixture.listeners.size).toBe(0);
    const valuesAfterStop = [...fixture.values];
    queuedCallback(1300);
    fixture.setReducedMotion(false);
    expect(fixture.values).toEqual(valuesAfterStop);
    expect(fixture.frames.size).toBe(0);
  });

  it('ignoriert unveränderte OS-Bewegungsfreigabe während des Laufs', () => {
    const fixture = animationFixture();
    fixture.setReducedMotion(false);
    expect(fixture.values).toEqual([0]);
    expect(fixture.frames.size).toBe(1);
    fixture.advance(600);
    expect(fixture.values.at(-1)).toBe(100);
  });

  it('räumt bei Unmount oder Profil-/Wertwechsel Frames und Listener auf', () => {
    const fixture = animationFixture();
    fixture.advance(100);
    const queuedCallback = fixture.pendingFrame();
    const queuedMotionListener = fixture.listeners.values().next().value;
    if (!queuedMotionListener) throw new Error('Expected a motion preference listener');
    fixture.stop();
    fixture.stop();
    expect(fixture.cancelled).toHaveLength(1);
    expect(fixture.frames.size).toBe(0);
    expect(fixture.listeners.size).toBe(0);
    const valuesAfterStop = [...fixture.values];
    queuedCallback(1300);
    queuedMotionListener({ matches: true });
    fixture.setReducedMotion(true);
    expect(fixture.values).toEqual(valuesAfterStop);
  });
});
