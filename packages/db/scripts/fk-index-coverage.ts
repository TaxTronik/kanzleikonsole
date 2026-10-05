// =============================================================================
// FK ohne führenden Index — Regel und Allowlist für `pnpm verify:fk-indexes`
// (Review-Finding D-05).
//
// Ohne Index auf der Kindseite liest PostgreSQL beim Löschen/Ändern einer
// Elternzeile (FK-Prüfung, ON DELETE CASCADE/SET NULL) die ganze Kindtabelle;
// Leser, die über die FK-Spalte joinen, ebenso. Nach der Bereinigung
// 20260801001800_iter93_fk_indexes kamen mit jedem neuen Modul wieder solche
// Fremdschlüssel hinzu.
//
// Ein Index trägt einen FK, wenn seine führenden Spalten FK-Spalten sind und
// darunter mindestens eine Nicht-Tenant-Spalte ist; ein führendes tenant_id
// davor ist erlaubt. Begründung: Unter RLS steht tenant_id = Kontext ohnehin in
// jeder App-Abfrage, und PostgreSQL 18 (CI, Produktion) überspringt ein
// führendes tenant_id per Skip Scan auch in der FK-Prüfung. Ein FK nur auf
// tenant_id gilt als getragen, sobald ein Index mit tenant_id beginnt.
// Partielle und Ausdrucksindizes zählen nicht.
// =============================================================================

export interface ForeignKeyInfo {
  /** Kindtabelle */
  table: string;
  /** FK-Spalten in Constraint-Reihenfolge */
  columns: string[];
  /** Elterntabelle */
  references: string;
  constraint: string;
}

export interface IndexInfo {
  table: string;
  /** Indexspalten in Indexreihenfolge (nur vollständige, ausdrucksfreie Indizes) */
  columns: string[];
}

export function foreignKeyId(fk: Pick<ForeignKeyInfo, 'table' | 'columns'>): string {
  return `${fk.table}.${fk.columns.join(',')}`;
}

export function indexCoversForeignKey(
  fkColumns: readonly string[],
  indexColumns: readonly string[],
): boolean {
  if (fkColumns.length === 1 && fkColumns[0] === 'tenant_id')
    return indexColumns[0] === 'tenant_id';
  for (let p = indexColumns[0] === 'tenant_id' ? 1 : 0; p < indexColumns.length; p++) {
    const column = indexColumns[p]!;
    if (!fkColumns.includes(column)) return false;
    if (column !== 'tenant_id') return true;
  }
  return false;
}

/**
 * Akteur- und Personenverweise: Mitarbeiter (staff_user) und Kontakte
 * (client_contact) werden deaktiviert bzw. anonymisiert, nie gelöscht. Die
 * FK-Prüfung läuft dafür praktisch nie, und kein Leser sucht über diese
 * Spalten; ein Index kostete nur Schreib-I/O.
 */
export const ACTOR_REFERENCES: readonly string[] = [
  'appointment.created_by_staff',
  'appointment_request.decided_by_staff',
  'appointment_request.preferred_staff_id',
  'client_interaction.contact_id',
  'gwg_structure_binding.created_by',
  'mandate_artifact.created_by',
  'mandate_offboarding.created_by',
  'mandate_offboarding_document.approved_by',
  'mandate_structure_version.created_by',
  'payroll_employer_grant.contact_id',
  'portal_inbox_attachment.decided_by_staff_id',
  'portal_inbox_read.contact_id',
  'portal_inbox_thread.created_by_contact_id',
  'portal_inbox_thread.resolved_by_staff_id',
  'vdb_record.created_by',
  'workflow_dependency.created_by',
  'workflow_instance.feedback_contact_id',
];

/**
 * FK auf tenant ohne Index mit führendem tenant_id: geprüft nur, wenn ein
 * ganzer Tenant gelöscht wird; die Tabellen werden über andere Schlüssel
 * gelesen.
 */
export const TENANT_REFERENCES: readonly string[] = [
  'client_reminder_note.tenant_id',
  'form_submission_revision.tenant_id',
  'mandate_offboarding_document.tenant_id',
  'mandate_structure_edge.tenant_id',
  'mandate_structure_node.tenant_id',
  'payroll_employee_data.tenant_id',
  'payroll_employee_invite.tenant_id',
  'payroll_employer_grant.tenant_id',
  'payroll_export.tenant_id',
  'payroll_external_task.tenant_id',
  'payroll_guest_session.tenant_id',
  'payroll_revision.tenant_id',
  'workflow_dependency.tenant_id',
  'workflow_n8n_dispatch.tenant_id',
  'year_end_campaign_entry.tenant_id',
];

/**
 * Bestand zum Review-Finding D-05 (Stand 2026-10-05): kleine Tabellen bzw.
 * selten gelöschte Elternzeilen, derzeit ohne messbaren Effekt. Beim nächsten
 * Anfassen des Moduls indizieren und hier streichen; neue Fremdschlüssel
 * gehören nicht in diese Liste.
 */
export const KNOWN_UNINDEXED: readonly string[] = [
  'appointment.from_request_id',
  'appointment_request.accepted_appointment_id',
  'bwa_plan.base_period_id',
  'client_assistance_case.external_document_version_id',
  'client_assistance_case.source_document_version_id',
  'client_assistance_revision.external_version_id',
  'client_assistance_revision.source_version_id',
  'client_custom_field_value.field_id',
  'form_submission_revision_file.document_version_id',
  'gwg_onboarding_invite.gwg_check_id',
  'gwg_structure_binding.structure_version_id',
  'mandate_artifact.client_id',
  'mandate_artifact.offboarding_id',
  'mandate_artifact.structure_version_id',
  'mandate_artifact_source.document_version_id',
  'mandate_offboarding_document.document_version_id',
  'mandate_structure_edge.from_node_id',
  'mandate_structure_edge.to_node_id',
  'mandate_structure_node.linked_client_id',
  'payroll_employee_invite.intake_id',
  'payroll_export.attachment_id',
  'payroll_export.intake_id',
  'payroll_guest_session.invite_id',
  'sanctions_source_state.tenant_id,snapshot_id',
  'screening_run.tenant_id,snapshot_id',
  'vdb_record.client_id',
  'vdb_record.evidence_version_id',
  'workflow_template.default_skill_id',
  'year_end_campaign.template_id',
  'year_end_campaign_entry.client_id',
];

export interface FkIndexReport {
  /** FK ohne führenden Index und ohne Allowlist-Eintrag */
  violations: ForeignKeyInfo[];
  /** Allowlist-Einträge ohne passenden ungedeckten FK (indiziert oder entfallen) */
  stale: string[];
  checked: number;
  allowlisted: number;
}

export function checkForeignKeyIndexes(
  foreignKeys: readonly ForeignKeyInfo[],
  indexes: readonly IndexInfo[],
  allowlist: readonly string[] = [...ACTOR_REFERENCES, ...TENANT_REFERENCES, ...KNOWN_UNINDEXED],
): FkIndexReport {
  const allowed = new Set(allowlist);
  const uncovered = foreignKeys.filter(
    (fk) =>
      !indexes.some(
        (index) => index.table === fk.table && indexCoversForeignKey(fk.columns, index.columns),
      ),
  );
  const uncoveredIds = new Set(uncovered.map(foreignKeyId));
  return {
    violations: uncovered.filter((fk) => !allowed.has(foreignKeyId(fk))),
    stale: [...allowed].filter((id) => !uncoveredIds.has(id)).sort(),
    checked: foreignKeys.length,
    allowlisted: uncovered.length - uncovered.filter((fk) => !allowed.has(foreignKeyId(fk))).length,
  };
}

/** Katalogabfragen für das öffentliche Schema (Owner- oder App-Verbindung). */
export const FOREIGN_KEYS_SQL = `
  SELECT c.conrelid::regclass::text AS "table",
         c.confrelid::regclass::text AS "references",
         c.conname::text AS "constraint",
         array_agg(a.attname::text ORDER BY k.ord) AS "columns"
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace AND n.nspname = 'public'
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
   WHERE c.contype = 'f'
   GROUP BY c.oid, c.conrelid, c.confrelid, c.conname
   ORDER BY 1, 3`;

export const INDEXES_SQL = `
  SELECT i.indrelid::regclass::text AS "table",
         array_agg(a.attname::text ORDER BY k.ord) AS "columns"
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
    -- nur Schlüsselspalten; INCLUDE-Spalten sind nicht durchsuchbar
    CROSS JOIN LATERAL unnest((i.indkey::int2[])[0:i.indnkeyatts - 1]) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
   WHERE i.indpred IS NULL AND i.indexprs IS NULL
   GROUP BY i.indexrelid, i.indrelid`;
