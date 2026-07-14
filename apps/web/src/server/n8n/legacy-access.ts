import { NextResponse } from 'next/server';
import { env } from '@taxtronik/config';

/**
 * Verbirgt die globalen Legacy-Callbacks vollständig, solange der Betreiber
 * sie nicht explizit freischaltet. Handler müssen diesen Gate als allererste
 * Operation ausführen – vor HMAC, Body-Lesen, Parametern und Datenbankzugriff.
 */
export function legacyN8nCallbackDisabledResponse(): NextResponse | null {
  if (env.N8N_LEGACY_CALLBACKS_ENABLED) return null;
  return new NextResponse(null, {
    status: 404,
    headers: { 'cache-control': 'no-store' },
  });
}
