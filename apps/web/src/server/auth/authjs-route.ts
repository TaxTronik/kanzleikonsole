// =============================================================================
// Auth.js-Routen auf die genutzten Endpunkte beschränken (B5, S-05)
//
// Fachkatalog: ACCESS-TENANT-RLS-001
//
// Die Catch-all-Routen /api/auth/staff/* und /api/auth/portal/* reichten jede
// Auth.js-Aktion weiter: session (stellt ein erneuertes Session-Cookie aus),
// signin und signout als HTML-Seiten, providers, error, verify-request und
// webauthn-options. Die App nutzt davon nur callback, signout und csrf. Die
// Anmeldung (staffSignIn in den Login-Actions) und die Abmeldung (Logout-
// Routen) rufen Auth.js serverseitig direkt auf (next-auth signIn/signOut ->
// Auth()), nicht über diese Route.
//
// Über HTTP gilt deshalb eine feste Liste aus Methode, Aktion und Provider:
//   - Treffer: unverändert an den Auth.js-Handler weiterreichen.
//   - Bekannte Aktion mit anderer Methode: 405 mit Allow-Header.
//   - Alles andere: 404 — ohne Auth.js aufzurufen, also ohne Cookie-,
//     Session- oder Provider-Verarbeitung.
//
// Aktion und Provider werden wie in Auth.js (parseActionAndProviderId) aus
// dem Pfad der Request-URL gelesen; die Entscheidung beruht damit auf genau
// dem Ziel, das Auth.js selbst bedienen würde.
// =============================================================================

export type AuthJsHttpMethod = 'GET' | 'POST';

export interface AuthJsEndpoint {
  readonly method: AuthJsHttpMethod;
  readonly action: 'callback' | 'csrf' | 'signout';
  /** Nur für `callback`: ID des Providers (`/callback/<providerId>`). */
  readonly providerId?: string;
}

export interface AuthJsRouteSpec {
  /** basePath der Auth.js-Konfiguration, z. B. `/api/auth/staff`. */
  readonly basePath: string;
  readonly endpoints: readonly AuthJsEndpoint[];
}

type AuthJsRouteHandler<R extends Request> = (request: R) => Promise<Response>;
export type AuthJsRouteHandlers<R extends Request> = Record<
  AuthJsHttpMethod,
  AuthJsRouteHandler<R>
>;

interface AuthJsTarget {
  action: string;
  providerId: string | undefined;
}

/** Wie Auth.js: Pfad relativ zum basePath, ein oder zwei nichtleere Segmente. */
function authJsTarget(request: Request, basePath: string): AuthJsTarget | null {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(`${basePath}/`)) return null;
  const segments = pathname.slice(basePath.length).split('/').filter(Boolean);
  if (segments.length < 1 || segments.length > 2) return null;
  return { action: segments[0]!, providerId: segments[1] };
}

function emptyResponse(status: 404 | 405, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

/**
 * Ersetzt die Auth.js-Route-Handler durch Handler, die nur die Endpunkte der
 * Liste an Auth.js weiterreichen (siehe Dateikopf).
 */
export function restrictAuthJsRoute<R extends Request>(
  handlers: AuthJsRouteHandlers<R>,
  spec: AuthJsRouteSpec,
): AuthJsRouteHandlers<R> {
  const handle = async (request: R): Promise<Response> => {
    const target = authJsTarget(request, spec.basePath);
    const matching = target
      ? spec.endpoints.filter(
          (endpoint) =>
            endpoint.action === target.action && endpoint.providerId === target.providerId,
        )
      : [];
    if (matching.length === 0) return emptyResponse(404);
    const endpoint = matching.find((candidate) => candidate.method === request.method);
    if (!endpoint) {
      const allow = [...new Set(matching.map((candidate) => candidate.method))].sort().join(', ');
      return emptyResponse(405, { allow });
    }
    return handlers[endpoint.method](request);
  };
  return { GET: handle, POST: handle };
}
