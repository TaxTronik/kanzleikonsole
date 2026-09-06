/** Untrusted headers produce suggestions only; callers supply accessible clients. */
export function suggestInboundClients(
  sender: string,
  recipients: string,
  clients: Array<{ id: string; name: string; contacts: Array<{ email: string }> }>,
) {
  const addresses = new Set(
    (
      (sender + ' ' + recipients).match(
        /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?/gi,
      ) ?? []
    ).map((address) => address.toLowerCase()),
  );
  return clients
    .filter((client) =>
      client.contacts.some((contact) => addresses.has(contact.email.toLowerCase())),
    )
    .map(({ id, name }) => ({ id, name }));
}
