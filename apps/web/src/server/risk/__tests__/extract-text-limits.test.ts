// P-22: PDF/DOCX-Extraktion läuft nicht im Event-Loop des Webprozesses, sondern
// begrenzt in einem Worker-Thread; jede Grenzverletzung wird zu einer
// generischen, nutzertauglichen Meldung.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ runBoundedWorker: vi.fn(), logError: vi.fn() }));
vi.mock('@taxtronik/mail/bounded-worker', () => ({ runBoundedWorker: m.runBoundedWorker }));
vi.mock('@/server/logger', () => ({ log: { error: m.logError } }));

import { extractText, TEXT_EXTRACTION_LIMITS, TextExtractionFailedError } from '../extract-text';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

beforeEach(() => {
  m.runBoundedWorker.mockReset();
  m.logError.mockReset();
});

describe('extractText im begrenzten Worker-Thread', () => {
  it('übergibt Bytes nur als Daten an ein festes Programm mit Grenzen', async () => {
    m.runBoundedWorker.mockResolvedValue({ ok: true, value: { ok: true, text: 'A\r\nB' } });
    const bytes = Buffer.from('%PDF');

    expect(await extractText(bytes, 'application/pdf')).toBe('A\nB');
    const [program, data, limits] = m.runBoundedWorker.mock.calls[0]!;
    expect(program).not.toContain('%PDF');
    // Der Thread löst den Parser selbst auf (kein Build-abhängiger Pfad im Servercode).
    expect(program).toContain("loadParser(workerData.kind === 'pdf' ? 'unpdf' : 'mammoth')");
    expect(data).toMatchObject({ kind: 'pdf', bytes, parserBases: expect.any(Array) });
    expect(data.parserBases.length).toBeGreaterThan(0);
    expect(limits).toBe(TEXT_EXTRACTION_LIMITS);
    expect(TEXT_EXTRACTION_LIMITS).toMatchObject({
      timeoutMs: 30_000,
      maxOldGenerationSizeMb: 256,
      rssBudgetBytes: 512 * 1024 * 1024,
    });
  });

  it('bereitet DOCX-HTML aus dem Thread im Webprozess auf', async () => {
    m.runBoundedWorker.mockResolvedValue({
      ok: true,
      value: { ok: true, text: '<p>Absatz</p><img src="">' },
    });

    expect(await extractText(Buffer.from('PK'), DOCX)).toBe('Absatz\n\n [Grafik]');
    expect(m.runBoundedWorker.mock.calls[0]![1]).toMatchObject({
      kind: 'docx',
      parserBases: expect.any(Array),
    });
  });

  it.each(['timeout', 'memory', 'error', 'exit', 'spawn'])(
    'meldet %s generisch als nicht lesbar',
    async (reason) => {
      m.runBoundedWorker.mockResolvedValue({ ok: false, reason });
      await expect(extractText(Buffer.from('%PDF'), 'application/pdf')).rejects.toBeInstanceOf(
        TextExtractionFailedError,
      );
      // Thread- oder Parserfehler (nicht die Datei) landen im Betriebslog.
      expect(m.logError).toHaveBeenCalledTimes(['error', 'spawn'].includes(reason) ? 1 : 0);
    },
  );

  it('parst text/* weiterhin direkt ohne Thread', async () => {
    expect(await extractText(Buffer.from('x'), 'text/plain')).toBe('x');
    expect(m.runBoundedWorker).not.toHaveBeenCalled();
  });
});
