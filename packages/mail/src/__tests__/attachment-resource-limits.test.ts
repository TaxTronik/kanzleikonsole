// Fachkatalog: MAIL-INBOX-001
import { EventEmitter } from 'node:events';
import { memoryUsage } from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  workers: [] as Array<EventEmitter & { terminate: ReturnType<typeof vi.fn> }>,
  options: [] as Array<Record<string, unknown>>,
}));
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    terminate = vi.fn(async () => 0);
    stdout = { resume: vi.fn() };
    stderr = { resume: vi.fn() };
    constructor(_program: string, options: Record<string, unknown>) {
      super();
      m.workers.push(this);
      m.options.push(options);
    }
  },
}));
vi.mock('@taxtronik/storage', () => ({
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
  detectMimeFromMagicBytes: () => 'application/pdf',
}));
import { classifyInboundAttachment } from '../attachments';
const bytes = Buffer.from('%PDF synthetic preflight fixture; never parsed by the mocked worker');
beforeEach(() => {
  m.workers.length = 0;
  m.options.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('PDF parser resource containment without hostile payloads', () => {
  it('terminates a nonresponsive parser and blocks the attachment after the deadline', async () => {
    const pending = classifyInboundAttachment(bytes);
    await vi.advanceTimersByTimeAsync(5001);
    expect((await pending).blocked).toContain('Ressourcenlimits');
    expect(m.workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(m.options[0]).toMatchObject({
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      stdout: true,
      stderr: true,
    });
  });
  it('also terminates on RSS growth outside the V8 heap budget', async () => {
    vi.spyOn(memoryUsage, 'rss')
      .mockReturnValueOnce(100)
      .mockReturnValue(128 * 1024 * 1024 + 101);
    const pending = classifyInboundAttachment(bytes);
    await vi.advanceTimersByTimeAsync(26);
    expect((await pending).blocked).toBeTruthy();
    expect(m.workers[0]!.terminate).toHaveBeenCalledOnce();
  });
  it('maps worker errors to a generic blocked result without leaking parser diagnostics', async () => {
    const pending = classifyInboundAttachment(bytes);
    m.workers[0]!.emit('error', new Error('synthetic-private-parser-diagnostic'));
    const result = await pending;
    expect(result.blocked).toBeTruthy();
    expect(result.blocked).not.toContain('synthetic-private');
  });
  it('uses unchanged attachment bytes and terminates the worker after a valid result', async () => {
    const pending = classifyInboundAttachment(bytes);
    expect(m.options[0]?.workerData).toEqual(expect.objectContaining({ bytes }));
    m.workers[0]!.emit('message', true);
    expect((await pending).blocked).toBeNull();
    expect(m.workers[0]!.terminate).toHaveBeenCalledOnce();
  });
});
