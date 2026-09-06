// =============================================================================
// EINZIGE Quelle der granularen Einzelrechte (iter87). Reines Daten-Modul ohne
// Server-/Client-Imports — dadurch in beiden Welten nutzbar (RBAC-Server,
// Admin-Action, Client-UI) und in reinen Unit-Tests ohne @prisma/client.
//
// Die Schlüssel spiegeln das DB-Enum StaffPermissionName (Prisma). Wer ein
// Recht hinzufügt, pflegt es HIER einmal — Label, UI-Kurztext und die
// zulässigen Werte für zod leiten sich daraus ab (vorher 4 Stellen, die
// auseinanderlaufen konnten).
// =============================================================================

export interface StaffPermissionMeta {
  key: string;
  /** Volltext-Label (Audit/Doku). */
  label: string;
  /** Kurzform für die Chip-Leiste in der Benutzerverwaltung. */
  short: string;
}

export const STAFF_PERMISSIONS = [
  { key: 'PAYROLL_MANAGE', label: 'Geschützte Personalfragebögen bearbeiten', short: 'Lohn' },
  {
    key: 'INBOUND_MAIL_MANAGE',
    label: 'Unzugeordnete E-Mail-Eingänge bearbeiten',
    short: 'Posteingang',
  },
  {
    key: 'PORTAL_INBOX_MANAGE',
    label: 'Sicheren Mandantenposteingang bearbeiten',
    short: 'Mandantenpost',
  },
  {
    key: 'CLIENT_CREATE',
    label: 'Mandanten anlegen (Schnellanlage und Onboarding)',
    short: 'Mand. anlegen',
  },
  {
    key: 'INVOICE_MANAGE',
    label: 'Rechnungen anlegen/bearbeiten (inkl. Zahlung/Storno)',
    short: 'Re. anlegen',
  },
  {
    key: 'INVOICE_SEND',
    label: 'Rechnungen versenden (Festschreibung, EXTERNAL-Upload)',
    short: 'Re. versenden',
  },
  {
    key: 'ABSENCE_DECIDE',
    label: 'Urlaub entscheiden / Abwesenheitsmeldungen erhalten',
    short: 'Urlaub entsch.',
  },
] as const satisfies readonly StaffPermissionMeta[];

export type StaffPermissionName = (typeof STAFF_PERMISSIONS)[number]['key'];

/** Zulässige Werte als Tuple — direkt für z.enum(...) nutzbar. */
export const STAFF_PERMISSION_VALUES = STAFF_PERMISSIONS.map((p) => p.key) as [
  StaffPermissionName,
  ...StaffPermissionName[],
];

export const PERMISSION_LABELS: Record<StaffPermissionName, string> = Object.fromEntries(
  STAFF_PERMISSIONS.map((p) => [p.key, p.label]),
) as Record<StaffPermissionName, string>;
