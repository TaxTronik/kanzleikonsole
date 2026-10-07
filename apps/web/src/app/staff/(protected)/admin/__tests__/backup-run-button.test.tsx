// Review B12: Der Backup-Button reiht nur den Worker-Job ein, der den Dump direkt
// in den Backup-Bucket streamt. Eine lokale Kopie unter backups/ entsteht nur
// mit `./taxtronik backup` auf dem Server — der Hinweis am Button sagt das.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { BackupRunButton } from '../backup-run-button';

describe('Backup-Button (B12)', () => {
  it('erklärt am Button, was der Job tut und wie eine lokale Kopie entsteht', () => {
    const html = renderToStaticMarkup(<BackupRunButton />);

    const describedBy = html.match(/<button[^>]*aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    const hint = html.slice(html.indexOf(`<p id="${describedBy}"`));
    expect(hint).toMatch(/^<p id="[^"]+" class="text-xs text-muted mt-2">/);
    expect(hint).toContain('Reiht den Backup-Job des Workers ein');
    expect(hint).toContain('direkt in den Backup-Bucket (S3), ohne lokale Kopie auf dem Server');
    expect(hint).toContain('Eine lokale Kopie unter <code>backups/</code>');
    expect(hint).toContain('<code>./taxtronik backup</code>');
  });
});
