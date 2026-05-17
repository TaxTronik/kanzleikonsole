import type { Config } from 'tailwindcss';

/**
 * Brand-Farben kommen aus CSS-Variablen, die das Layout pro Tenant setzt
 * (siehe server/settings/branding.ts und globals.css).
 *
 * Wenn keine Tenant-Branding gesetzt ist, fallen die Variablen auf das
 * Default (--brand-600: #2563eb) zurück. Das hex-Default ist als statischer
 * Fallback in globals.css `:root` definiert.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  // Class-basierter Darkmode — wird am <html> gesetzt vom ThemeProvider.
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50: 'rgb(var(--brand-50) / <alpha-value>)',
          100: 'rgb(var(--brand-100) / <alpha-value>)',
          500: 'rgb(var(--brand-500) / <alpha-value>)',
          600: 'rgb(var(--brand-600) / <alpha-value>)',
          700: 'rgb(var(--brand-700) / <alpha-value>)',
          900: 'rgb(var(--brand-900) / <alpha-value>)',
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
