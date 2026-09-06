import { withTenantContext, type TxClient } from '@taxtronik/db';

export interface PortalProfileOption {
  contactId: string;
  clientId: string;
  clientName: string;
  contactName: string;
  email: string;
}

const profileSelect = {
  id: true,
  clientId: true,
  fullName: true,
  email: true,
  client: { select: { name: true } },
} as const;

function toProfile(contact: {
  id: string;
  clientId: string;
  fullName: string;
  email: string;
  client: { name: string };
}): PortalProfileOption {
  return {
    contactId: contact.id,
    clientId: contact.clientId,
    clientName: contact.client.name,
    contactName: contact.fullName,
    email: contact.email,
  };
}

/**
 * Liefert alle aktiven Portalprofile fuer dieselbe E-Mail innerhalb genau
 * eines Tenants. Die Parent-Mandanten muessen die GwG-/Anonymisierungs-Gates
 * passieren. Der Helper wird sowohl vom Magic-Link-Chooser als auch vom
 * Profilwechsel verwendet, damit beide Pfade dieselben Sicherheitsregeln
 * anwenden.
 */
async function findEligiblePortalProfilesByEmailTx(
  tx: TxClient,
  input: {
    tenantId: string;
    email: string;
  },
): Promise<PortalProfileOption[]> {
  const contacts = await tx.clientContact.findMany({
    where: {
      tenantId: input.tenantId,
      email: input.email.toLowerCase(),
      active: true,
      client: { allowActive: true, anonymizedAt: null, mandateEndedAt: null },
    },
    select: profileSelect,
    orderBy: [{ client: { name: 'asc' } }, { createdAt: 'asc' }],
  });
  return contacts.map(toProfile);
}

export async function findEligiblePortalProfilesByEmail(input: {
  tenantId: string;
  email: string;
}): Promise<PortalProfileOption[]> {
  return withTenantContext({ tenantId: input.tenantId, actorId: null, actorType: 'SYSTEM' }, (tx) =>
    findEligiblePortalProfilesByEmailTx(tx, input),
  );
}

/**
 * Ermittelt die fuer eine laufende Session umschaltbaren Profile. Die E-Mail
 * muss weiterhin zur verifizierten Session passen. Eine zwischenzeitliche
 * Stammdaten-Aenderung darf keine fremde Mailbox-Identitaet uebernehmen.
 */
export async function findPortalProfilesForContact(input: {
  tenantId: string;
  contactId: string;
  email: string;
}): Promise<PortalProfileOption[]> {
  return withTenantContext(
    { tenantId: input.tenantId, actorId: input.contactId, actorType: 'CLIENT_CONTACT' },
    (tx) => findPortalProfilesForContactTx(tx, input),
  );
}

async function findPortalProfilesForContactTx(
  tx: TxClient,
  input: { tenantId: string; contactId: string; email: string },
): Promise<PortalProfileOption[]> {
  const current = await tx.clientContact.findFirst({
    where: {
      id: input.contactId,
      tenantId: input.tenantId,
      active: true,
      client: { allowActive: true, anonymizedAt: null, mandateEndedAt: null },
    },
    select: { email: true },
  });
  if (!current || current.email.trim().toLowerCase() !== input.email.trim().toLowerCase())
    return [];
  return findEligiblePortalProfilesByEmailTx(tx, {
    tenantId: input.tenantId,
    email: current.email,
  });
}

/** Fail-closed Aufloesung eines Profilwechsels innerhalb derselben Identitaet. */
export async function resolvePortalProfileSwitch(input: {
  tenantId: string;
  currentContactId: string;
  targetContactId: string;
  email: string;
}): Promise<PortalProfileOption | null> {
  return withTenantContext(
    {
      tenantId: input.tenantId,
      actorId: input.currentContactId,
      actorType: 'CLIENT_CONTACT',
    },
    (tx) => resolvePortalProfileSwitchTx(tx, input),
  );
}

export async function resolvePortalProfileSwitchTx(
  tx: TxClient,
  input: { tenantId: string; currentContactId: string; targetContactId: string; email: string },
): Promise<PortalProfileOption | null> {
  const profiles = await findPortalProfilesForContactTx(tx, {
    tenantId: input.tenantId,
    contactId: input.currentContactId,
    email: input.email,
  });
  return profiles.find((profile) => profile.contactId === input.targetContactId) ?? null;
}
