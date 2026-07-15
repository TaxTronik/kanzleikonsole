import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260801004200_gwg_destruction_lifecycle_lock/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

function expectOrdered(contents: string, ...needles: string[]): void {
  let cursor = -1;
  for (const needle of needles) {
    const next = contents.indexOf(needle, cursor + 1);
    expect(next, `Reihenfolge/Marker verletzt: ${needle}`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

describe('GwG-Check-Vernichtung – Lifecycle-Lock-Migration', () => {
  it('nimmt den identischen Tenant-/Mandanten-Lock vor dem Vernichtungskern', () => {
    expect(migration).toContain(
      "'gwg-check-lifecycle:' || check_tenant::TEXT || ':' || check_client::TEXT",
    );
    expectOrdered(
      migration,
      'SELECT gc."tenant_id", gc."client_id"',
      'app.current_tenant_id()',
      'pg_catalog.pg_advisory_xact_lock(',
      'pg_catalog.hashtextextended(lifecycle_lock_key, 0)',
      'RETURN app.destroy_gwg_check_locked_impl(p_check_id);',
    );
  });

  it('verhindert einen direkten App-Aufruf des ungesperrten Implementierungskerns', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION app.destroy_gwg_check_locked_impl(UUID) FROM PUBLIC;',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION app.destroy_gwg_check_locked_impl(UUID) FROM taxtronik_app;',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION app.destroy_gwg_check(UUID) TO taxtronik_app;',
    );
  });
});
