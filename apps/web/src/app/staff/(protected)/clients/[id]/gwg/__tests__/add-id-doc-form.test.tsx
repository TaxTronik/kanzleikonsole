// @vitest-environment jsdom
// Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
import { act, render, screen, waitFor } from '@testing-library/react';
import { Profiler, type ComponentProps } from 'react';
import { expect, it, vi } from 'vitest';
import type { DocumentUploadButton } from '@/components/document-upload-button';
import { AddIdDocumentForm } from '../add-id-doc-form';
import { addIdDocumentAction } from '../id-document-actions';

vi.mock('../id-document-actions', () => ({ addIdDocumentAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/components/document-preview', () => ({ DocumentPreviewButton: () => null }));
vi.mock('@/components/document-upload-button', () => ({
  DocumentUploadButton: ({ disabled, onUploaded }: ComponentProps<typeof DocumentUploadButton>) =>
    ['Erster Beleg', 'Zweiter Beleg'].map((title) => (
      <button
        key={title}
        type="button"
        disabled={disabled}
        onClick={() => void onUploaded?.({ id: title, title })}
      >
        {title}
      </button>
    )),
}));

it('ordnet den nächsten Beleg beim ersten Klick nach der sichtbaren Speicherbestätigung zu', async () => {
  let freigeben!: (result: { ok: true }) => void;
  const ersteSpeicherung = new Promise<{ ok: true }>((resolve) => {
    freigeben = resolve;
  });
  const speichern = vi
    .mocked(addIdDocumentAction)
    .mockReturnValueOnce(ersteSpeicherung)
    .mockResolvedValueOnce({ ok: true });
  let naechsterBeleg = false;
  render(
    <Profiler
      id="Nachweiszuordnung"
      onRender={() => {
        if (naechsterBeleg || !screen.queryByText('Nachweis wurde direkt zugeordnet.')) return;
        const zweiter = screen.getByRole<HTMLButtonElement>('button', { name: 'Zweiter Beleg' });
        if (zweiter.disabled) return;
        naechsterBeleg = true;
        zweiter.click();
      }}
    >
      <AddIdDocumentForm checkId="check" clientId="mandant" clientDocuments={[]} variant="entity" />
    </Profiler>,
  );
  await act(async () => screen.getByRole('button', { name: 'Erster Beleg' }).click());
  expect(speichern).toHaveBeenCalledOnce();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Zweiter Beleg' }).disabled).toBe(
    true,
  );
  await act(async () => freigeben({ ok: true }));
  await waitFor(() => expect(speichern).toHaveBeenCalledTimes(2));
  expect(speichern.mock.calls.map(([, data]) => data.getAll('documentIds'))).toEqual([
    ['Erster Beleg'],
    ['Zweiter Beleg'],
  ]);
});
