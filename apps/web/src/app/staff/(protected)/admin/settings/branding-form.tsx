'use client';

import { useActionState, useState } from 'react';
import { saveBrandingAction, type ActionResult } from './actions';
import type { BrandingInfo } from '@/server/settings/branding';
import { TenantLogo } from '@/components/tenant-logo';
import { FileButton } from '@/components/file-button';
import { brandContrastInfo } from '@/lib/brand-palette';

const MAX_LOGO_BYTES = 200 * 1024; // 200 KB nach base64
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function safeHexColor(value: string): string {
  return HEX_COLOR_RE.test(value) ? value : '#2563eb';
}

export function BrandingForm({ initial }: { initial: BrandingInfo }) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    saveBrandingAction,
    null,
  );
  const [accent, setAccent] = useState(initial.accentColor);
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [subtitle, setSubtitle] = useState(initial.subtitle ?? '');
  const [logo, setLogo] = useState<string | null>(initial.logoDataUrl);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoDark, setLogoDark] = useState<string | null>(initial.logoDataUrlDark);
  const [logoDarkError, setLogoDarkError] = useState<string | null>(null);

  // Gemeinsamer Lese+Validierungs-Pfad für hell/dunkel-Logo. Das File-Input
  // selbst wird NICHT übermittelt — die Daten-URL fließt via FileReader in den
  // React-State und von dort ins versteckte Feld (s. FileButton ohne name).
  function readLogo(
    file: File,
    onError: (m: string | null) => void,
    onData: (d: string) => void,
  ): void {
    onError(null);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      onError('Nur PNG, JPG oder WebP erlaubt.');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      onError(`Datei zu groß (max. ${Math.round(MAX_LOGO_BYTES / 1024)} KB).`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => onData(String(reader.result));
    reader.readAsDataURL(file);
  }

  const previewAccent = safeHexColor(accent);
  const accentIsValid = HEX_COLOR_RE.test(accent);
  const contrast = brandContrastInfo(previewAccent);
  const contrastDescription =
    contrast.onBrandHex === '#000000'
      ? `Die Akzentfarbe ist hell. Weiße Beschriftung hätte nur ${contrast.whiteContrast.toFixed(2)}:1 Kontrast. Die Oberfläche verwendet deshalb automatisch schwarze Beschriftung mit ${contrast.onBrandContrast.toFixed(2)}:1; die Markenfarbe bleibt unverändert.`
      : `Auf der Akzentfarbe verwendet die Oberfläche automatisch weiße Beschriftung mit ${contrast.onBrandContrast.toFixed(2)}:1 Kontrast.`;

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label className="label" htmlFor="displayName">
          Anzeige-Name
        </label>
        <input
          id="displayName"
          name="displayName"
          type="text"
          className="input"
          required
          maxLength={100}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <p className="text-xs text-muted mt-1">Erscheint oben in der Sidebar statt „taxtronik"</p>
      </div>

      <div>
        <label className="label" htmlFor="subtitle">
          Untertitel (optional)
        </label>
        <input
          id="subtitle"
          name="subtitle"
          type="text"
          className="input"
          maxLength={100}
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
          placeholder="z. B. „Mandantendashboard"
        />
      </div>

      <fieldset>
        <legend className="label">Akzent-Farbe</legend>
        <div className="flex flex-wrap items-center gap-3">
          <input
            id="accentColorPicker"
            type="color"
            className="h-10 w-16 rounded border border-default cursor-pointer"
            value={previewAccent}
            onChange={(e) => setAccent(e.target.value)}
            aria-label="Akzent-Farbe auswählen"
            aria-describedby="accentColorHelp accentColorContrast"
          />
          <input type="hidden" name="accentColor" value={accent} />
          <label htmlFor="accentColorHex" className="sr-only">
            Akzent-Farbe als Hex-Wert
          </label>
          <input
            id="accentColorHex"
            type="text"
            className="input font-mono"
            value={accent}
            onChange={(e) => setAccent(e.target.value)}
            pattern="^#[0-9a-fA-F]{6}$"
            maxLength={7}
            required
            aria-invalid={!accentIsValid}
            aria-describedby="accentColorHelp accentColorContrast"
          />
        </div>
        <p id="accentColorHelp" className="text-xs text-muted mt-1">
          Hex-Format, z. B. #2563eb (Standard)
        </p>
        <p
          id="accentColorContrast"
          className="mt-2 text-xs text-secondary"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {accentIsValid
            ? contrastDescription
            : 'Sobald der Hex-Wert vollständig ist, wird der Kontrast automatisch geprüft.'}
        </p>
      </fieldset>

      <div>
        <span className="label">Logo — hell (PNG/JPG/WebP, max. 200 KB)</span>
        <div className="mt-1">
          <FileButton
            id="logoFile"
            accept="image/png,image/jpeg,image/webp"
            onSelect={(f) => readLogo(f, setLogoError, setLogo)}
          >
            Logo auswählen
          </FileButton>
        </div>
        <input type="hidden" name="logoDataUrl" value={logo ?? ''} />
        {logoError && (
          <p className="text-xs text-red-700 mt-1" role="alert">
            {logoError}
          </p>
        )}
        {logo && (
          <div className="mt-2 flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- Logo previews are tenant-provided data URLs. */}
            <img
              src={logo}
              alt="Logo-Vorschau hell"
              className="h-12 max-w-[200px] object-contain border border-default rounded"
            />
            <button
              type="button"
              onClick={() => setLogo(null)}
              className="text-xs text-red-700 hover:underline"
            >
              Entfernen
            </button>
          </div>
        )}
      </div>

      <div>
        <span className="label">Logo — dunkel für Dark Mode (optional)</span>
        <div className="mt-1">
          <FileButton
            id="logoFileDark"
            accept="image/png,image/jpeg,image/webp"
            onSelect={(f) => readLogo(f, setLogoDarkError, setLogoDark)}
          >
            Dark-Logo auswählen
          </FileButton>
        </div>
        <input type="hidden" name="logoDataUrlDark" value={logoDark ?? ''} />
        {logoDarkError && (
          <p className="text-xs text-red-700 mt-1" role="alert">
            {logoDarkError}
          </p>
        )}
        {logoDark ? (
          <div className="mt-2 flex items-center gap-3">
            <div className="rounded p-1 bg-gray-900">
              {/* eslint-disable-next-line @next/next/no-img-element -- Logo previews are tenant-provided data URLs. */}
              <img
                src={logoDark}
                alt="Logo-Vorschau dunkel"
                className="h-12 max-w-[200px] object-contain"
              />
            </div>
            <button
              type="button"
              onClick={() => setLogoDark(null)}
              className="text-xs text-red-700 hover:underline"
            >
              Entfernen
            </button>
          </div>
        ) : (
          <p className="text-xs text-muted mt-1">
            Ohne Dark-Logo gilt das hell-Logo in beiden Themes.
          </p>
        )}
      </div>

      <div
        className="rounded-md p-4 border border-default"
        style={{ backgroundColor: `${previewAccent}15` }}
      >
        <p className="text-xs text-secondary uppercase tracking-wide mb-2">Vorschau</p>
        <div className="flex flex-wrap items-center gap-3">
          {logo || logoDark ? (
            <TenantLogo
              branding={{ logoDataUrl: logo, logoDataUrlDark: logoDark }}
              alt={displayName}
              className="h-9 object-contain"
            />
          ) : (
            <span className="text-xl font-bold" style={{ color: previewAccent }}>
              {displayName}
            </span>
          )}
          {subtitle && <span className="text-sm text-secondary">{subtitle}</span>}
          <span
            className="ml-auto rounded-md px-3 py-2 text-xs font-semibold"
            style={{ backgroundColor: contrast.accentHex, color: contrast.onBrandHex }}
          >
            Schaltflächen-Vorschau
          </span>
        </div>
      </div>

      {state?.error && (
        <div className="alert-error-sm" role="alert">
          {state.error}
        </div>
      )}
      {state?.ok && (
        <div className="alert-success-sm" role="status" aria-live="polite">
          Gespeichert. Die Änderung wird beim nächsten Pageload sichtbar.
        </div>
      )}

      <button type="submit" className="btn-primary" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Branding speichern'}
      </button>
    </form>
  );
}
