// @vitest-environment jsdom
// Fachkatalog: FORM-PRESUBMIT-UPLOAD-001, FORM-SCHEMA-SNAPSHOT-001
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { FormFieldType } from '@prisma/client';
import { expect, it, vi } from 'vitest';
import { PortalFormFiller } from '../filler';
import { confirmDialog } from '@/components/ui/modal';

vi.mock('@/components/ui/modal', () => ({ confirmDialog: vi.fn(async () => false) }));

vi.mock('../actions', () => ({
  discardFormFileAction: vi.fn(),
  saveSubmissionDraftAction: vi.fn(),
  submitSubmissionAction: vi.fn(),
  uploadFormFileAction: vi.fn(),
}));

it('verknüpft Feldbeschriftungen, Hilfetexte und Auswahlgruppen mit ihren Eingaben', () => {
  const types: FormFieldType[] = [
    'TEXT',
    'EMAIL',
    'PHONE',
    'TEXTAREA',
    'NUMBER',
    'MONEY',
    'DATE',
    'SELECT',
    'CHECKBOX',
  ];
  const fields = [...types, 'FILE' as const, 'MULTISELECT' as const].map((type) => ({
    id: type,
    key: type,
    label: `Feld ${type}`,
    type,
    required: type === 'FILE',
    helpText: `Hilfe ${type}`,
    defaultValue: null,
    minValue: null,
    maxValue: null,
    options: [{ value: 'a', label: 'Option A' }],
  }));
  render(
    <PortalFormFiller
      fields={fields}
      initialAnswers={{}}
      submitted={false}
      requestClosed={false}
      submissionId="test"
    />,
  );

  for (const type of types) {
    const input = screen.getByLabelText(`Feld ${type}`, { exact: true });
    expect(input.id).toBe(type);
    expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe(
      `Hilfe ${type}`,
    );
  }
  const group = screen.getByRole('group', { name: 'Feld MULTISELECT' });
  expect(within(group).getByRole('checkbox', { name: 'Option A' })).toBeTruthy();
  const file = screen.getByLabelText(/Feld FILE.*Pflichtfeld.*Datei auswählen/);
  expect(file.getAttribute('type')).toBe('file');
  expect(
    file
      .getAttribute('aria-describedby')
      ?.split(' ')
      .map((id) => document.getElementById(id)?.textContent),
  ).toEqual(['Hilfe FILE', expect.stringContaining('Max.')]);
});

it('prüft eine Pflichtbestätigung vor dem Absendedialog', async () => {
  const field = {
    id: 'check',
    key: 'check',
    label: 'Angaben geprüft',
    type: 'CHECKBOX' as const,
    required: true,
    helpText: null,
    defaultValue: null,
    minValue: null,
    maxValue: null,
    options: null,
  };
  render(
    <PortalFormFiller
      fields={[field]}
      initialAnswers={{}}
      submitted={false}
      requestClosed={false}
      submissionId="test"
    />,
  );
  const send = screen.getByRole('button', { name: 'Absenden' });
  fireEvent.click(send);
  expect(screen.getByRole('alert').textContent).toBe(
    'Pflichtfeld nicht bestätigt: Angaben geprüft',
  );
  expect(confirmDialog).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox', { name: /Angaben geprüft/ }));
  fireEvent.click(send);
  expect(confirmDialog).toHaveBeenCalledTimes(1);
});
