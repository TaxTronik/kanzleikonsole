// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useActionState } from 'react';
import { expect, it, vi } from 'vitest';
import { SettingsForm, SettingsFormGuard } from '../settings-form-guard';

type Result = { ok: boolean };
type Action = (previous: Result | null, form: FormData) => Promise<Result>;

function Example({ save }: { save: Action }) {
  const [result, action, pending] = useActionState(save, null);
  return (
    <SettingsForm result={result} action={action} pending={pending} className="">
      <label>
        Name <input name="name" defaultValue="Alt" required />
      </label>
      <button type="submit" disabled={pending}>
        Einzelformular speichern
      </button>
      {result && !result.ok && <p role="alert">Abgelehnt</p>}
    </SettingsForm>
  );
}

function mount(save: Action) {
  render(
    <SettingsFormGuard>
      <Example save={save} />
    </SettingsFormGuard>,
  );
  return screen.getByRole('textbox') as HTMLInputElement;
}

it('behält ungültige Einstellungen im Änderungsstand und meldet keinen Erfolg', () => {
  const save = vi.fn(async () => ({ ok: true }));
  const input = mount(save);
  fireEvent.input(input, { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
  expect(save).not.toHaveBeenCalled();
  expect(screen.queryByText('Gespeichert')).toBeNull();
  expect(screen.getByRole('button', { name: 'Speichern' })).toBeTruthy();
  expect(fireEvent(window, new Event('beforeunload', { cancelable: true }))).toBe(false);
});

it('bewahrt bei Serverfehlern Eingaben und ermöglicht das erneute Speichern', async () => {
  const save = vi
    .fn<Action>()
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValueOnce({ ok: true });
  const input = mount(save);
  fireEvent.input(input, { target: { value: 'Änderung' } });
  fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
  await screen.findByRole('alert');
  expect(input.value).toBe('Änderung');
  expect(screen.queryByText('Gespeichert')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
  await screen.findByText('Gespeichert');
  expect(save.mock.calls.map(([, data]) => data.get('name'))).toEqual(['Änderung', 'Änderung']);
  expect(fireEvent(window, new Event('beforeunload', { cancelable: true }))).toBe(true);
});

it('lässt während des Speicherns eingegebene Änderungen offen', async () => {
  let finish!: (result: Result) => void;
  const save = vi.fn<Action>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const input = mount(save);
  fireEvent.input(input, { target: { value: 'Erster Stand' } });
  fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
  await screen.findByRole('button', { name: 'Speichert …' });
  expect(screen.getByRole('button', { name: 'Verwerfen' }).matches(':disabled')).toBe(true);
  expect(screen.queryByText('Gespeichert')).toBeNull();
  fireEvent.input(input, { target: { value: 'Zweiter Stand' } });
  await act(async () => finish({ ok: true }));
  expect(input.value).toBe('Zweiter Stand');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Speichern' })).toBeTruthy());
  expect(save.mock.calls[0]?.[1].get('name')).toBe('Erster Stand');
});

it('warnt nach Abbruch weiter und lässt genau den bestätigten Reload passieren', async () => {
  const unload = () => window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
  const reload = vi.fn(unload);
  const input = mount(vi.fn(async () => ({ ok: true })));
  const location = vi
    .spyOn(window, 'location', 'get')
    .mockReturnValue({ reload } as unknown as Location);
  try {
    fireEvent.input(input, { target: { value: 'Neuer Name' } });
    expect(screen.getByRole('status').textContent).toContain('ungespeicherte Änderung');
    fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(unload()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Verwerfen' }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(reload.mock.results[0]?.value).toBe(true);
    expect(unload()).toBe(false);
  } finally {
    location.mockRestore();
  }
});
