import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import './globals.css';

export const metadata: Metadata = {
  title: 'TaxTronik',
  description: 'Kanzlei- und Mandanten-Dashboard',
};

// Alle Routes als dynamic markieren: TaxTronik ist eine on-prem-App mit
// authentifizierten Sessions, jede Page macht entweder Auth-Check oder
// DB-Calls beim Render. Static Generation würde während des Builds eine
// echte DB-Verbindung verlangen (gibt's im Build-Container nicht) und
// hilft uns ohnehin nichts (kein User sieht statische Inhalte).
export const dynamic = 'force-dynamic';

// Anti-FOUC: setzt Theme-/UI-Mode-Klasse VOR dem ersten Paint. MUSS ein
// synchrones INLINE-Script im SSR-HTML sein — eine externe Datei (extra
// Request) flackert beim Refresh kurz im hellen Modus.
//
// React 19 / Next 16 zeigen dafür im DEV-Mode eine Konsolen-Warnung
// ("Encountered a script tag…"). Bewusst akzeptiert: a) reine
// Development-Meldung, der Production-Build (React prod) gibt sie NICHT
// aus; b) das Script läuft beim initialen Laden korrekt (steht im
// SSR-HTML), nur bei Client-Navigationen führt React es nicht erneut aus
// — irrelevant, das Theme ist dann bereits gesetzt. Flicker-Freiheit für
// echte Nutzer schlägt eine Dev-only-Warnung.
const bootstrap = `
(function () {
  try {
    function cookie(name) {
      var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    }
    var t = localStorage.getItem('theme');
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var dark = t === 'dark' || (t !== 'light' && prefersDark);
    if (dark) document.documentElement.classList.add('dark');
    var ui = localStorage.getItem('ui_mode') || cookie('ui_mode');
    document.documentElement.classList.toggle('ui-modern', ui === 'modern');
  } catch (_) {}
})();
`.trim();

export default async function RootLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  const uiMode = jar.get('ui_mode')?.value;

  return (
    <html lang="de" className={uiMode === 'modern' ? 'ui-modern' : undefined} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: bootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
