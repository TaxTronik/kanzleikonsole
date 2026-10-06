import { NextResponse } from 'next/server';
import { env } from '@taxtronik/config';
import { log } from '@/server/logger';

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

/** Legacy-Callbacks unter /api/n8n mit ihrem tenantgebundenen v1-Nachfolger. */
const LEGACY_CALLBACKS = {
  'expiring-gwg-checks': {
    route: '/api/n8n/expiring-gwg-checks',
    replacement: '/api/integrations/n8n/v1/expiring-gwg-checks',
  },
  'overdue-requests': {
    route: '/api/n8n/overdue-requests',
    replacement: '/api/integrations/n8n/v1/overdue-requests',
  },
  'request-detail': {
    route: '/api/n8n/request-detail/[id]',
    replacement: '/api/integrations/n8n/v1/request-detail/[id]',
  },
  'request-inbound': {
    route: '/api/n8n/request-inbound',
    replacement: '/api/integrations/n8n/v1/request-inbound',
  },
  'research-result': {
    route: '/api/n8n/research-result',
    replacement: '/api/integrations/n8n/v1/research-result',
  },
} as const;

export type LegacyN8nCallbackRoute = keyof typeof LEGACY_CALLBACKS;

const reportedRoutes = new Set<LegacyN8nCallbackRoute>();

/**
 * Deprecation-Signal für die Abschaltentscheidung: meldet je Route und Prozess
 * genau einmal, dass ein Workflow einen Legacy-Callback noch erfolgreich
 * signiert aufruft. Handler rufen das erst nach der HMAC-Prüfung auf, damit
 * unsignierte Anfragen kein Nutzungssignal erzeugen. Die Warnung ist einmalig,
 * damit ein aktiver Workflow das Log nicht flutet; nach einem Neustart
 * erscheint sie beim nächsten Aufruf erneut.
 */
export function reportLegacyN8nCallbackUse(route: LegacyN8nCallbackRoute): void {
  if (reportedRoutes.has(route)) return;
  reportedRoutes.add(route);
  log.warn(
    { component: 'n8n-legacy', ...LEGACY_CALLBACKS[route] },
    'n8n-legacy: deprecated callback in use; migrate the workflow to the v1 callback',
  );
}
