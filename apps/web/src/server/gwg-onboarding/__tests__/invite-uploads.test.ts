// Fachkatalog: GWG-SELF-ONBOARDING-001
//
// Review-Finding D-08: Die Zuordnung Upload → Einladung kommt allein aus dem
// Fremdschlüssel document.gwg_onboarding_invite_id.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TxClient } from '@taxtronik/db';
import { describe, expect, it, vi } from 'vitest';

import {
  FINALIZED_INVITE_UPLOAD,
  inviteUploadIds,
  loadInviteUploadedDocumentsTx,
} from '../invite-uploads';

const WEB_SRC = fileURLToPath(new URL('../../../', import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__' && name !== 'node_modules') sourceFiles(path, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe('Uploads einer GwG-Einladung (D-08)', () => {
  it('wertet nur Dokumente mit finalisierter Version als Upload', () => {
    expect(FINALIZED_INVITE_UPLOAD).toEqual({ versions: { some: { scanStatus: 'CLEAN' } } });
  });

  it('liefert die IDs der Relation und ohne Einladung keine', () => {
    expect(inviteUploadIds({ uploadedDocuments: [{ id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b']);
    expect(inviteUploadIds(null)).toEqual([]);
    expect(inviteUploadIds(undefined)).toEqual([]);
  });

  it('liest die Kanzleiansicht über den Fremdschlüssel ohne vernichtete Belege', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const tx = { document: { findMany } } as unknown as TxClient;
    await loadInviteUploadedDocumentsTx(tx, { clientId: 'client-1', inviteId: 'invite-1' });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        clientId: 'client-1',
        gwgOnboardingInviteId: 'invite-1',
        gwgDestroyedAt: null,
        versions: { some: { scanStatus: 'CLEAN' } },
      },
      select: { id: true, title: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('liest die veraltete JSON-Liste nirgends mehr, der Upload pflegt sie nur', () => {
    const hits = sourceFiles(WEB_SRC).flatMap((file) => {
      const rel = relative(WEB_SRC, file).split(sep).join('/');
      return readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
        .filter((line) => /uploadedDocumentIds|uploaded_document_ids/.test(line))
        .map((line) => `${rel}: ${line.trim()}`);
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(
      /^app\/gwg-onboarding\/actions\.ts: SET uploaded_document_ids = uploaded_document_ids \|\| /,
    );
  });
});
