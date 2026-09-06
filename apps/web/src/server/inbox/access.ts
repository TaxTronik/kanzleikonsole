import type { TxClient } from '@taxtronik/db';
import { filterStaffAccessClientTx } from '@taxtronik/db/staff-client-access';
import { readTenantSettingValue } from '@taxtronik/db/tenant-settings';
import type { StaffSession } from '@/server/auth/staff';
import { ActionError, assertClientAccessTx } from '@/server/auth/rbac';

// Fachkatalog: ACCESS-TENANT-RLS-001, ACCESS-STAFF-PERMISSION-001,
// CLIENT-MANDATE-LIFECYCLE-001, PORTAL-INBOX-SUBMISSION-001 (Entwurf).

const PORTAL_FEATURES_KEY = 'portal.features';

interface StoredPortalFeatures {
  clientInbox?: unknown;
  documentUpload?: unknown;
}

function asPortalFeatures(value: unknown): StoredPortalFeatures {
  return value !== null && typeof value === 'object' ? (value as StoredPortalFeatures) : {};
}

/**
 * Featureflags werden innerhalb derselben Tenant-Transaktion wie der Write
 * erneut gelesen. `clientInbox` ist absichtlich opt-in; `documentUpload`
 * bleibt aus Kompatibilitaetsgruenden nur bei explizitem false deaktiviert.
 */
export async function assertInboxFeatureTx(
  tx: TxClient,
  tenantId: string,
  options: { requireUpload?: boolean } = {},
): Promise<void> {
  const features = asPortalFeatures(
    await readTenantSettingValue(tx, tenantId, PORTAL_FEATURES_KEY),
  );
  if (features.clientInbox !== true) {
    throw new ActionError('Das Nachrichtenfach ist nicht aktiviert.');
  }
  if (options.requireUpload && features.documentUpload === false) {
    throw new ActionError('Dateiuploads sind im Mandantenportal nicht aktiviert.');
  }
}

export async function assertActivePortalInboxIdentityTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    contactId: string;
    requireUpload?: boolean;
  },
): Promise<void> {
  await assertInboxFeatureTx(tx, input.tenantId, { requireUpload: input.requireUpload });

  const contact = await tx.clientContact.findFirst({
    where: {
      id: input.contactId,
      tenantId: input.tenantId,
      clientId: input.clientId,
      active: true,
      client: {
        tenantId: input.tenantId,
        allowActive: true,
        anonymizedAt: null,
        mandateEndedAt: null,
      },
    },
    select: { id: true },
  });
  if (!contact) {
    // Keine Unterscheidung zwischen Profil-, Mandats- und Kontaktfehlern:
    // externe Akteure erhalten keine Existenz- oder Statusdetails.
    throw new ActionError('Das Mandantenprofil ist nicht mehr aktiv.');
  }
}

export async function assertStaffInboxClientTx(
  tx: TxClient,
  session: StaffSession,
  clientId: string,
  options: { requireUpload?: boolean } = {},
): Promise<void> {
  const { tenantId } = session.user;
  await assertInboxFeatureTx(tx, tenantId, options);
  await assertClientAccessTx(tx, session, clientId);

  const client = await tx.client.findFirst({
    where: {
      id: clientId,
      tenantId,
      allowActive: true,
      anonymizedAt: null,
      mandateEndedAt: null,
    },
    select: { id: true },
  });
  if (!client) throw new ActionError('Das Mandat ist nicht aktiv.');
}

/**
 * Eine Zuweisung erweitert nie den Mandantenzugriff. Neben aktiver Identitaet
 * und Inbox-Recht gilt deshalb fuer den Zielmitarbeiter die aktuelle
 * OPEN/RESTRICTED-/Vertraulich-Policy des Mandanten.
 */
export async function eligibleInboxStaffIdsTx(
  tx: TxClient,
  tenantId: string,
  clientId: string,
  candidateIds: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(candidateIds)].filter(Boolean);
  if (unique.length === 0) return new Set();

  const staff = await tx.staffUser.findMany({
    where: {
      tenantId,
      id: { in: unique },
      active: true,
      OR: [
        { permissions: { some: { permission: 'PORTAL_INBOX_MANAGE' } } },
        { roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } } },
      ],
    },
    select: { id: true },
  });
  return filterStaffAccessClientTx(
    tx,
    tenantId,
    staff.map((entry) => entry.id),
    clientId,
  );
}
