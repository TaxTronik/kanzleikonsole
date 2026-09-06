import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DateTimePicker } from '../datetime-picker';

describe('DateTimePicker als Formularelement', () => {
  it.each([false, true])(
    'deaktiviert sichtbare Eingabe und FormData-Wert gemeinsam (%s)',
    (disabled) => {
      const html = renderToStaticMarkup(
        <form>
          <DateTimePicker name="appointment" value="2026-09-07T10:30" disabled={disabled} />
        </form>,
      );
      const hidden = html.match(/<input\b[^>]*\btype="hidden"[^>]*>/)?.[0];
      const visible = html.match(/<input\b[^>]*\btype="text"[^>]*>/)?.[0];
      expect(hidden).toBeDefined();
      expect(visible).toBeDefined();
      expect(hidden).toContain('name="appointment"');
      expect(hidden).toContain('value="2026-09-07T10:30"');
      expect(hidden!.includes('disabled=""')).toBe(disabled);
      expect(visible!.includes('disabled=""')).toBe(disabled);
    },
  );
});
