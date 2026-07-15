export function resolveInitialPoaClientId(
  clients: ReadonlyArray<{ id: string }>,
  requestedClientId: string | undefined,
): { initialClientId: string | undefined; requestedClientAvailable: boolean } {
  const requestedClientAvailable = Boolean(
    requestedClientId && clients.some((client) => client.id === requestedClientId),
  );
  return {
    requestedClientAvailable,
    initialClientId: requestedClientAvailable
      ? requestedClientId
      : requestedClientId
        ? undefined
        : clients[0]?.id,
  };
}
