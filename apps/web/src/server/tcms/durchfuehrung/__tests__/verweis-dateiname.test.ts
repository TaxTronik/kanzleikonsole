// TCMS s8: Dateiname eines Nachweis-Verweises aus dem Titel der Ablage – mit
// der Zeichenregel des Vertrags still bereinigt (server/tcms/zeichen.ts); das
// Ergebnis besteht immer die Regel des Vertrags, sonst „Nachweis“.
// Fachkatalog: TCMS-NACHWEIS-001
import { gueltigerNachweisDateiname } from '@taxtronik/tcms-contract';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { nachweisDateiname } from '../verweis';

describe('nachweisDateiname', () => {
  it('entfernt unsichtbare Zeichen, Pfadtrenner werden „_“', () => {
    const titel = `Konto${String.fromCodePoint(0x200e, 0x034f)}abgleich/Q3${String.fromCodePoint(0x2764, 0xfe0f, 0xe0041)}`;
    const name = nachweisDateiname(titel, 'application/pdf');
    expect(name).toBe(`Kontoabgleich_Q3${String.fromCodePoint(0x2764)}.pdf`);
    expect(gueltigerNachweisDateiname(name)).toBe(true);
  });

  it('nichts Gültiges übrig → „Nachweis“; sonst nur die Endung', () => {
    const unsichtbar = String.fromCodePoint(0x200b, 0x180b);
    expect(nachweisDateiname(unsichtbar, 'application/octet-stream')).toBe('Nachweis');
    expect(nachweisDateiname(unsichtbar, 'application/pdf')).toBe('.pdf');
    expect(gueltigerNachweisDateiname(nachweisDateiname('..', 'text/plain'))).toBe(true);
  });
});
