// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { DragHandle, SortableList } from '../sortable-list';

function Example({ reordered }: { reordered: (from: number, to: number) => void }) {
  const [values, setValues] = useState(['Erstes', 'Zweites', 'Drittes']);
  return (
    <SortableList
      count={values.length}
      onReorder={(from, to) => {
        reordered(from, to);
        const next = [...values];
        next.splice(to, 0, ...next.splice(from, 1));
        setValues(next);
      }}
      renderItem={(i, handle) => (
        <>
          <DragHandle handle={handle} />
          <span>{values[i]}</span>
        </>
      )}
    />
  );
}

it('verschiebt über native Schaltflächen und führt den Fokus mit dem Eintrag', () => {
  render(<Example reordered={vi.fn()} />);
  const down = screen.getByRole('button', { name: 'Element 1 nach unten verschieben' });
  down.focus();
  fireEvent.click(down);
  expect(
    screen
      .getByText('Erstes')
      .closest('[data-sortable-index]')
      ?.getAttribute('data-sortable-index'),
  ).toBe('1');
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Element 2 nach unten verschieben' }),
  );
});

it('ignoriert fremde Zeiger und verwirft den Drag bei Abbruch', () => {
  const reordered = vi.fn();
  const { container } = render(<Example reordered={reordered} />);
  const grip = screen.getAllByTitle('Ziehen zum Verschieben')[0]!;
  Object.defineProperty(grip, 'setPointerCapture', { value: vi.fn() });
  const items = [...container.querySelectorAll<HTMLElement>('[data-sortable-index]')];
  items.forEach((element, index) => {
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, index * 10, 10, 10));
  });
  fireEvent.pointerDown(grip, { pointerId: 1, button: 0 });
  fireEvent.pointerMove(grip, { pointerId: 1, clientY: 28 });
  fireEvent.pointerUp(grip, { pointerId: 2, clientY: 28 });
  expect(reordered).not.toHaveBeenCalled();
  fireEvent.pointerCancel(grip, { pointerId: 1 });
  fireEvent.pointerUp(grip, { pointerId: 1, clientY: 28 });
  expect(reordered).not.toHaveBeenCalled();
  fireEvent.pointerDown(grip, { pointerId: 3, button: 0 });
  fireEvent.pointerMove(grip, { pointerId: 3, clientY: 28 });
  fireEvent.pointerUp(grip, { pointerId: 3, clientY: 28 });
  expect(reordered).toHaveBeenCalledExactlyOnceWith(0, 2);
});
