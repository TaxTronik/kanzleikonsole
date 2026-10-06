// K-10: Der Worker registriert Logger und n8n-Emitter des Mail-Pakets explizit
// beim Start (index.ts) genau einmal — der Import von ./mail hat keine
// Seiteneffekte mehr.
import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  setMailLogger: vi.fn(),
  setN8nEmitter: vi.fn(),
  emit: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@taxtronik/mail', () => ({
  setMailLogger: m.setMailLogger,
  setN8nEmitter: m.setN8nEmitter,
}));
vi.mock('../logger', () => ({ log: m.log }));
vi.mock('../n8n-emit', () => ({ emitN8nEventFromWorker: m.emit }));

import { registerWorkerMailIntegrations } from '../mail';

describe('Mail-Anbindung des Workers', () => {
  it('registriert erst auf ausdrücklichen Aufruf und genau einmal', () => {
    expect(m.setN8nEmitter).not.toHaveBeenCalled();
    expect(m.setMailLogger).not.toHaveBeenCalled();

    registerWorkerMailIntegrations();
    registerWorkerMailIntegrations();

    expect(m.setN8nEmitter).toHaveBeenCalledOnce();
    expect(m.setN8nEmitter).toHaveBeenCalledWith(m.emit);
    expect(m.setMailLogger).toHaveBeenCalledOnce();
    expect(m.setMailLogger).toHaveBeenCalledWith(m.log);
  });
});
