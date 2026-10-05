/**
 * Ein ausdrücklich übergebener Mandant (Onboarding, Mandantenakte) wird nur
 * vorausgewählt, wenn die Seite ihn sichtbar und zulässig geladen hat. Ohne
 * Kontext gibt es keine stille Vorauswahl mehr (früher: alphabetisch erster
 * Mandant); der Mandant wird bewusst über die Serversuche gewählt.
 */
export function resolveInitialPoaClientId<T extends { id: string }>(
  requestedClient: T | null,
  requestedClientId: string | undefined,
): {
  initialClientId: string | undefined;
  initialClient: T | undefined;
  requestedClientAvailable: boolean;
} {
  const available = requestedClientId && requestedClient?.id === requestedClientId;
  return {
    requestedClientAvailable: Boolean(available),
    initialClientId: available ? requestedClientId : undefined,
    initialClient: available ? requestedClient! : undefined,
  };
}
