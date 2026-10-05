import type { Config } from 'tailwindcss';

/**
 * Brand-Farben kommen aus CSS-Variablen, die das Layout pro Tenant setzt
 * (siehe server/settings/branding.ts, lib/brand-palette.ts und globals.css).
 *
 * Wenn keine Tenant-Branding gesetzt ist, fallen die Variablen auf das
 * Default (--brand-600: #2563eb) zurück. Das hex-Default ist als statischer
 * Fallback in globals.css `:root` definiert. Alle elf Stufen (50–950) müssen
 * hier, in `:root` und in `brandPaletteStyle()` existieren — eine fehlende
 * Stufe erzeugt stillschweigend kein CSS (Guard: app/__tests__/tailwind-classes).
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  // Class-basierter Darkmode — wird am <html> gesetzt vom ThemeProvider.
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'on-brand': 'rgb(var(--text-on-brand) / <alpha-value>)',
        focus: 'rgb(var(--brand-focus) / <alpha-value>)',
        brand: {
          50: 'rgb(var(--brand-50) / <alpha-value>)',
          100: 'rgb(var(--brand-100) / <alpha-value>)',
          200: 'rgb(var(--brand-200) / <alpha-value>)',
          300: 'rgb(var(--brand-300) / <alpha-value>)',
          400: 'rgb(var(--brand-400) / <alpha-value>)',
          500: 'rgb(var(--brand-500) / <alpha-value>)',
          600: 'rgb(var(--brand-600) / <alpha-value>)',
          700: 'rgb(var(--brand-700) / <alpha-value>)',
          800: 'rgb(var(--brand-800) / <alpha-value>)',
          900: 'rgb(var(--brand-900) / <alpha-value>)',
          950: 'rgb(var(--brand-950) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
