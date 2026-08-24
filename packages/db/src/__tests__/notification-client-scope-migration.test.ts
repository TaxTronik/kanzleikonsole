import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260823202000_notification_client_scope/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('Notification-Client-Scope-Migration', () => {
  // Fachkatalog: TAX-NOTICE-APPEAL-001, TAX-CONTROL-STATUS-001
  it('backfillt direkte und abgeleitete Mandantenressourcen nur über tenantgleiche Quellen', () => {
    for (const type of [
      'tax_notice',
      'client_reminder',
      'pending_binder',
      'request',
      'invoice',
      'client_reminder_note',
      'gwg_onboarding_invite',
      'gwg_id_document',
      'risk_marking',
      'risk_research_result',
    ]) {
      expect(migration).toContain(`notification."resource_type" = '${type}'`);
    }
    expect(migration).toContain('reminder."tenant_id" = note."tenant_id"');
    expect(migration).toContain('notification."tenant_id" = check_row."tenant_id"');
    expect(migration).toContain('notification."tenant_id" = resolved."tenant_id"');
    const backfillEnd = migration.indexOf('-- Die historische Einzel-FK');
    expect(backfillEnd).toBeGreaterThan(-1);
    expect(migration.slice(0, backfillEnd)).not.toContain('"href"');
  });

  it('klassifiziert unbekannte oder halb gesetzte Ressourcen fail-closed', () => {
    expect(migration).toContain(
      'SELECT scope.resource_is_known\n         AND scope.resource_was_found',
    );
    expect(migration).not.toContain('SELECT NOT scope.resource_is_known');
    expect(migration).toContain('Unklassifizierter Notification-Ressourcentyp');
    expect(migration).toContain('Notification-Ressourcenlink ist nur halb gesetzt');
    expect(migration).toContain('app.current_tenant_id() IS DISTINCT FROM p_tenant_id');
  });

  it('erzwingt bei Staff-Reads und -Mutationen Empfänger plus aktuellen Fachzugriff', () => {
    const recipientClauses = migration.match(
      /AND \("staff_id" IS NULL OR "staff_id" = app\.current_actor_id\(\)\)/g,
    );
    expect(recipientClauses).toHaveLength(4);

    const resourceMatchCalls = migration.match(/app\.notification_resource_matches_client\(/g);
    // Funktionsdefinition/Portalpfad plus SELECT, INSERT, beide UPDATE-Gates und DELETE.
    expect(resourceMatchCalls?.length ?? 0).toBeGreaterThanOrEqual(7);
    expect(migration).toContain('OR NEW."staff_id" IS DISTINCT FROM OLD."staff_id"');
  });
});
