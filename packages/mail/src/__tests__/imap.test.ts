// Fachkatalog: MAIL-INBOX-001
type FakeRow = Record<string, unknown>;
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  tx: null as unknown as ReturnType<typeof makeTx>,
  enabled: true,
  options: null as unknown,
  open: vi.fn(),
  download: vi.fn(),
  logout: vi.fn(),
  scan: vi.fn(),
  put: vi.fn(),
  parse: vi.fn(),
  connect: vi.fn(),
  uids: [1],
}));
vi.mock('@taxtronik/db', () => ({
  withSystemContext: async (_tenant: string, fn: (tx: ReturnType<typeof makeTx>) => unknown) =>
    fn(m.tx),
}));
vi.mock('@taxtronik/db/tenant-modules', () => ({
  readBooleanTenantModules: async () => ({ smartMailbox: m.enabled }),
}));
vi.mock('@taxtronik/crypto', () => ({
  encryptSecret: (x: string) => x,
  decryptSecret: (x: string) => x,
}));
vi.mock('@taxtronik/storage', () => ({
  scanBytes: m.scan,
  putObjectBytes: m.put,
  getBucketForTier: () => 'staging',
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
  detectMimeFromMagicBytes: (b: Buffer) =>
    b.subarray(0, 4).toString() === '%PDF' ? 'application/pdf' : null,
}));
vi.mock('mailparser', () => ({ simpleParser: m.parse }));
vi.mock('@azure/msal-node', () => ({ ConfidentialClientApplication: class {} }));
vi.mock('../attachments', () => ({
  classifyInboundAttachment: async (bytes: Buffer) => ({
    mime: 'application/pdf',
    blocked: bytes.includes(Buffer.from('/Encrypt'))
      ? 'Verschlüsseltes PDF'
      : bytes.subarray(0, 4).toString() === '%PDF'
        ? null
        : 'Nicht prüfbar',
  }),
}));
vi.mock('imapflow', () => ({
  ImapFlow: class {
    constructor(options: unknown) {
      m.options = options;
    }
    connect = m.connect;
    mailboxOpen = m.open;
    download = m.download;
    logout = m.logout;
    close = vi.fn();
    async *fetch() {
      for (const uid of m.uids)
        yield { uid, size: 512, envelope: { subject: '<script>alert(1)</script>' } };
    }
  },
}));
import { classifyInboundAttachment, pollMailbox, IMAP_SCOPES } from '../imap';
let account: FakeRow;
let message: FakeRow | undefined;
let attachment: FakeRow | undefined;
const messages = new Map<number, FakeRow>();
function makeTx() {
  return {
    inboundMailbox: {
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => account,
      findFirst: async () => (account.enabled ? account : null),
      update: async ({ data }: { data: FakeRow }) => Object.assign(account, data),
    },
    inboundMessage: {
      upsert: async ({ create }: { create: FakeRow }) => {
        message = messages.get(create.uid as number);
        if (!message) {
          message = { id: 'message-' + create.uid, status: 'PENDING', ...create };
          messages.set(create.uid as number, message);
        }
        return message;
      },
      update: async ({ data }: { data: FakeRow }) => Object.assign(message!, data),
    },
    inboundAttachment: {
      upsert: async ({ create }: { create: FakeRow }) =>
        attachment ?? (attachment = { id: 'attachment', status: 'PENDING', ...create }),
      update: async ({ data }: { data: FakeRow }) => Object.assign(attachment!, data),
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  m.enabled = true;
  message = undefined;
  messages.clear();
  m.uids = [1];
  attachment = undefined;
  account = {
    id: 'mailbox',
    tenantId: 'tenant',
    provider: 'IMAP',
    host: 'mail.example.test',
    port: 993,
    username: 'inbox@example.test',
    folder: 'INBOX',
    secretEnc: 'secret',
    enabled: true,
    uidValidity: null,
    lastUid: 0,
  };
  m.open.mockResolvedValue({ uidValidity: 1n });
  m.download.mockImplementation(async () => ({
    content: Readable.from([Buffer.from('synthetic MIME')]),
  }));
  m.logout.mockResolvedValue(undefined);
  m.connect.mockResolvedValue(undefined);
  m.scan.mockResolvedValue('CLEAN');
  m.put.mockResolvedValue(undefined);
  m.parse.mockResolvedValue({
    text: 'Text only',
    from: { text: 'Fake <boss@example.test>' },
    to: { text: 'client-alias@example.test' },
    attachments: [{ filename: 'receipt.pdf', content: Buffer.from('%PDF-1.7\nsynthetic') }],
  });
  m.tx = makeTx();
});
describe('read-only receipt import', () => {
  it('MAIL-INBOX-001 blocks an excessive attachment count and still imports the next UID', async () => {
    m.uids = [1, 2];
    m.parse.mockResolvedValueOnce({
      attachments: Array.from({ length: 51 }, () => ({
        filename: 'tiny.txt',
        content: Buffer.from('tiny'),
      })),
    });
    await pollMailbox('tenant', 'mailbox');
    expect(messages.get(1)?.status).toBe('BLOCKED');
    expect(messages.get(2)?.status).toBe('COMPLETE');
    expect(account.lastUid).toBe(2);
    expect(m.put).toHaveBeenCalledTimes(1);
    await pollMailbox('tenant', 'mailbox');
    expect(m.parse).toHaveBeenCalledTimes(2);
    expect(account.lastUid).toBe(2);
  });

  it('opens with verified TLS and readonly mode; stages scanned bytes without creating an archive document', async () => {
    await pollMailbox('tenant', 'mailbox');
    expect(m.options).toMatchObject({
      secure: true,
      tls: { rejectUnauthorized: true },
      logger: false,
      auth: { user: 'inbox@example.test' },
    });
    expect(m.open).toHaveBeenCalledWith('INBOX', { readOnly: true });
    expect(m.download).toHaveBeenCalledWith('1', undefined, {
      uid: true,
      maxBytes: 25 * 1024 * 1024 + 1,
      chunkSize: 65536,
    });
    expect(attachment!.status).toBe('CLEAN');
    expect(attachment!.documentId).toBeUndefined();
    expect(m.scan).toHaveBeenCalledOnce();
    expect(m.put).toHaveBeenCalledOnce();
    expect(account.lastUid).toBe(1);
  });
  it('replays a committed receipt without downloading it and recovers a lagging cursor', async () => {
    await pollMailbox('tenant', 'mailbox');
    account.lastUid = 0;
    m.download.mockClear();
    await pollMailbox('tenant', 'mailbox');
    expect(m.download).not.toHaveBeenCalled();
    expect(account.lastUid).toBe(1);
    expect(m.put).toHaveBeenCalledOnce();
  });
  it('fails closed on scanner outage then resumes exactly the same attachment', async () => {
    m.scan.mockResolvedValueOnce('ERROR');
    await pollMailbox('tenant', 'mailbox');
    expect(attachment!.status).toBe('SCAN_ERROR');
    expect(m.put).not.toHaveBeenCalled();
    expect(account.lastUid).toBe(0);
    await pollMailbox('tenant', 'mailbox');
    expect(attachment!.status).toBe('CLEAN');
    expect(m.put).toHaveBeenCalledOnce();
    expect(account.lastUid).toBe(1);
  });
  it('never provides infected or encrypted bytes', async () => {
    m.scan.mockResolvedValue('INFECTED');
    await pollMailbox('tenant', 'mailbox');
    expect(attachment!.status).toBe('BLOCKED');
    expect(m.put).not.toHaveBeenCalled();
    expect(
      (await classifyInboundAttachment(Buffer.from('%PDF-1.7 /Encrypt 1 0 R'))).blocked,
    ).toContain('Verschlüsseltes');
    expect((await classifyInboundAttachment(Buffer.from('PK archive'))).blocked).not.toBeNull();
  });
  it('pauses before import if UIDVALIDITY changed', async () => {
    account.uidValidity = 'previous';
    await pollMailbox('tenant', 'mailbox');
    expect(account.enabled).toBe(false);
    expect(account.lastError).toContain('UIDVALIDITY_CHANGED');
    expect(m.download).not.toHaveBeenCalled();
  });
  it('makes no connection when the module is disabled', async () => {
    m.enabled = false;
    await pollMailbox('tenant', 'mailbox');
    expect(m.connect).not.toHaveBeenCalled();
  });
  it('does not release staged bytes when the module is disabled during storage I/O', async () => {
    m.put.mockImplementationOnce(async () => {
      m.enabled = false;
    });
    await pollMailbox('tenant', 'mailbox');
    expect(attachment!.status).toBe('PENDING');
    expect(account.lastUid).toBe(0);
    expect(account.claimedUntil).toBeNull();
  });
  it('holds corrupt MIME without advancing the cursor or releasing an attachment', async () => {
    m.parse.mockRejectedValueOnce(new Error('broken MIME'));
    await pollMailbox('tenant', 'mailbox');
    expect(account.lastUid).toBe(0);
    expect(m.put).not.toHaveBeenCalled();
    expect(account.lastError).toBeTruthy();
  });
  it('rejects changed attachment bytes for an existing immutable receipt', async () => {
    m.scan.mockResolvedValueOnce('ERROR');
    await pollMailbox('tenant', 'mailbox');
    m.parse.mockResolvedValueOnce({
      attachments: [{ filename: 'receipt.pdf', content: Buffer.from('%PDF-other bytes') }],
    });
    await pollMailbox('tenant', 'mailbox');
    expect(m.put).not.toHaveBeenCalled();
    expect(account.lastUid).toBe(0);
  });
  it('blocks oversized streamed bytes despite forged small metadata without parsing or staging', async () => {
    m.download.mockResolvedValueOnce({
      content: Readable.from([Buffer.alloc(25 * 1024 * 1024), Buffer.from('x')]),
    });
    await pollMailbox('tenant', 'mailbox');
    expect(message!.status).toBe('BLOCKED');
    expect(account.lastUid).toBe(1);
    expect(m.parse).not.toHaveBeenCalled();
    expect(m.put).not.toHaveBeenCalled();
  });
  it('requests only delegated IMAP and sign-in scopes', () => {
    expect(IMAP_SCOPES).toEqual([
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'offline_access',
      'openid',
      'profile',
    ]);
  });
});
