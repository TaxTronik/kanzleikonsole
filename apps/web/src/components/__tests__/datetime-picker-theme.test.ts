import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const pickerSource = readFileSync(resolve(__dirname, '../datetime-picker.tsx'), 'utf8');
const profileSwitcherSource = readFileSync(
  resolve(__dirname, '../../app/portal/(protected)/profile-switcher.tsx'),
  'utf8',
);
const globalCss = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8');

describe('theme-aware overlays', () => {
  it('scopes the DateTimePicker popover and replaces the fragile float layout', () => {
    expect(pickerSource).toContain('popperClassName="taxtronik-datetime-popper"');
    expect(pickerSource).toContain('calendarClassName="taxtronik-datetime-calendar"');
    expect(pickerSource).toContain('popperPlacement="bottom-end"');
    expect(pickerSource).toContain('required={required}');
    expect(pickerSource).toContain("aria-required={required ? 'true' : undefined}");
    expect(pickerSource).not.toContain('value={serialized} required={required}');
    expect(globalCss).toContain('.taxtronik-datetime-calendar.react-datepicker');
    expect(globalCss).toContain('grid-template-columns: minmax(0, 15.5rem) 6rem');
    expect(globalCss).toContain('background-color: rgb(var(--surface-card))');
    expect(globalCss).toContain('align-items: start');
    expect(globalCss).toContain('height: 16.25rem !important');
    expect(globalCss).toContain('li.react-datepicker__time-list-item:hover');
    expect(globalCss).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(globalCss).toContain('height: 10rem !important');
  });

  it('uses semantic selected-profile colors in both themes', () => {
    expect(profileSwitcherSource).toContain("aria-current={current ? 'page' : undefined}");
    expect(profileSwitcherSource).toContain('bg-surface-raised');
    expect(profileSwitcherSource).not.toContain('disabled:bg-brand-50');
    expect(profileSwitcherSource).not.toContain('dark:disabled:bg-brand-950');
    expect(profileSwitcherSource).toContain('switchingRef.current = true');
    expect(profileSwitcherSource).toContain('disabled={current || switching}');
  });
});
