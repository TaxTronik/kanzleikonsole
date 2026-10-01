// Fachkatalog: ASSURANCE-RELEASE-EVIDENCE-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn() }));
vi.mock('pg', () => ({
  Client: class {
    connect = client.connect;
    query = client.query;
    end = client.end;
  },
}));
import { resetShadowAppSchema } from '../../scripts/drift-shadow';

beforeEach(() => {
  vi.resetAllMocks();
  client.connect.mockResolvedValue(undefined);
  client.end.mockResolvedValue(undefined);
});

describe('shadow identity before destructive SQL', () => {
  const shadow = 'postgresql://owner:secret@localhost/office_shadow';
  const source = 'postgresql://owner:secret@localhost/office';

  it('refuses an aliased connection to the real target without issuing DROP', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [{ database: 'office' }] })
      .mockResolvedValueOnce({ rows: [{ database: 'office' }] });
    await expect(resetShadowAppSchema(shadow, [source])).rejects.toThrow('ausdrücklich benannte');
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query).toHaveBeenCalledWith('SELECT current_database() AS database');
    expect(client.end).toHaveBeenCalledTimes(2);
  });

  it('resolves source pooler aliases before a shadow connection can drop their actual database', async () => {
    client.query.mockResolvedValueOnce({ rows: [{ database: 'office_shadow' }] });
    await expect(resetShadowAppSchema(shadow, [source])).rejects.toThrow('denselben');
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith('SELECT current_database() AS database');
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('does not issue any SQL after a connection failure and closes the client', async () => {
    client.connect.mockRejectedValueOnce(new Error('connection refused'));
    await expect(resetShadowAppSchema(shadow, [source])).rejects.toThrow('connection refused');
    expect(client.query).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledOnce();
  });
});
