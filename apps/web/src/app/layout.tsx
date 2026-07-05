import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { THEME_BOOTSTRAP_JS } from '@/lib/theme';
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

// Anti-FOUC: setzt Theme-/UI-Mode-Klasse VOR dem ersten Paint über ein
// synchrones INLINE-Script im SSR-HTML (eine externe Datei flackert beim
// Refresh kurz hell). Der Script-Inhalt lebt zentral in @/lib/theme
// (THEME_BOOTSTRAP_JS), damit Theme-Logik nicht mehr dreifach divergiert.
//
// React 19 / Next 16 zeigen dafür im DEV-Mode eine Konsolen-Warnung
// ("Encountered a script tag…"). Bewusst akzeptiert: reine Development-Meldung
// (Production-Build gibt sie nicht aus); das Script läuft beim initialen Laden
// korrekt, bei Client-Navigationen ist das Theme bereits gesetzt.

export default async function RootLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  const uiMode = jar.get('ui_mode')?.value;

  return (
    <html lang="de" className={uiMode === 'modern' ? 'ui-modern' : undefined} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_JS }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
