'use client';

import { useActionState, useState } from 'react';
import { saveBrandingAction, type ActionResult } from './actions';
import type { BrandingInfo } from '@/server/settings/branding';

const MAX_LOGO_BYTES = 200 * 1024; // 200 KB nach base64

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

  function onLogoFileChange(e: React.ChangeEvent<HTMLInputElement>): void {
    setLogoError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'].includes(file.type)) {
      setLogoError('Nur PNG, JPG, SVG oder WebP erlaubt.');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError(`Datei zu groß (max. ${Math.round(MAX_LOGO_BYTES / 1024)} KB).`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      setLogo(dataUrl);
    };
    reader.readAsDataURL(file);
  }

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label className="label" htmlFor="displayName">Anzeige-Name</label>
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
        <p className="text-xs text-gray-500 mt-1">Erscheint oben in der Sidebar statt „taxtronik"</p>
      </div>

      <div>
        <label className="label" htmlFor="subtitle">Untertitel (optional)</label>
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

      <div>
        <label className="label" htmlFor="accentColor">Akzent-Farbe</label>
        <div className="flex items-center gap-3">
          <input
            id="accentColor"
            name="accentColor"
            type="color"
            className="h-10 w-16 rounded border border-gray-200 cursor-pointer"
            value={accent}
            onChange={(e) => setAccent(e.target.value)}
          />
          <input
            type="text"
            className="input font-mono"
            value={accent}
            onChange={(e) => setAccent(e.target.value)}
            pattern="^#[0-9a-fA-F]{6}$"
            maxLength={7}
            required
          />
        </div>
        <p className="text-xs text-gray-500 mt-1">Hex-Format, z. B. #2563eb (Standard)</p>
      </div>

      <div>
        <label className="label" htmlFor="logoFile">Logo (PNG/JPG/SVG, max. 200 KB)</label>
        <input
          id="logoFile"
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          onChange={onLogoFileChange}
          className="block text-sm text-gray-700"
        />
        <input type="hidden" name="logoDataUrl" value={logo ?? ''} />
        {logoError && <p className="text-xs text-red-700 mt-1">{logoError}</p>}
        {logo && (
          <div className="mt-2 flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={logo} alt="Logo-Vorschau" className="h-12 max-w-[200px] object-contain border border-gray-200 rounded" />
            <button
              type="button"
              onClick={() => setLogo(null)}
              className="text-xs text-red-700 hover:underline"
            >
              Logo entfernen
            </button>
          </div>
        )}
      </div>

      <div className="rounded-md p-4 border border-gray-200" style={{ backgroundColor: accent + '15' }}>
        <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Vorschau</p>
        <div className="flex items-center gap-3">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt={displayName} className="h-9 object-contain" />
          ) : (
            <span className="text-xl font-bold" style={{ color: accent }}>{displayName}</span>
          )}
          {subtitle && <span className="text-sm text-gray-500">{subtitle}</span>}
        </div>
      </div>

      {state?.error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{state.error}</div>
      )}
      {state?.ok && (
        <div className="rounded-md bg-green-50 p-3 text-sm text-green-700">
          Gespeichert. Die Änderung wird beim nächsten Pageload sichtbar.
        </div>
      )}

      <button type="submit" className="btn-primary" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Branding speichern'}
      </button>
    </form>
  );
}
