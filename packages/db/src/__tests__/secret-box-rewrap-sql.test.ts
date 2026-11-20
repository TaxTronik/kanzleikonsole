// S-08: SQL-Texte des Secret-Box-Re-Wraps (ohne Datenbank).
// Tabellen- und Spaltennamen stammen ausschließlich aus der festen Liste des
// Moduls; ein fremder oder präparierter Ablageort bricht vor jeder Abfrage ab.
import { SECRET_SLOTS } from '@taxtronik/crypto/secret-slots';
import { describe, expect, it } from 'vitest';
import { anwendungAbgewiesen } from '../testing/db-fehler';
import {
  rewrapStoredSecrets,
  type RewrapSlot,
  type SecretBoxRewrapOps,
  type SqlExecutor,
} from '../secret-box-rewrap';

const ops: SecretBoxRewrapOps<null> = {
  contextFor: () => null,
  looksEncrypted: () => true,
  rewrap: (blob) => ({ blob, changed: false }),
  describe: () => ({ version: 'v3', keyId: null }),
};

/** Zeichnet jede Abfrage auf und liefert keine Zeilen. */
function recordingExecutor(): SqlExecutor & { calls: Array<{ text: string; values: unknown[] }> } {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    async query(text, values = []) {
      calls.push({ text, values });
      return { rows: [] };
    },
  };
}

function columnSlot(table: string, column: string): RewrapSlot {
  return { kind: 'column', table, column, row: 'id' };
}

describe('S-08: Secret-Box-Re-Wrap setzt nur feste Bezeichner in SQL ein', () => {
  it('unterstützt jeden Spalten-Ablageort aus SECRET_SLOTS mit festem Lese-SQL', async () => {
    const columns = Object.entries(SECRET_SLOTS).filter(([, slot]) => slot.kind === 'column');
    expect(columns.length).toBeGreaterThan(0);
    for (const [name, slot] of columns) {
      if (slot.kind !== 'column') continue;
      const db = recordingExecutor();
      await rewrapStoredSecrets(db, [{ name, slot }], ops);
      expect(db.calls).toHaveLength(1);
      expect(db.calls[0]!.text).toContain(`FROM public."${slot.table}"`);
      expect(db.calls[0]!.text).toContain(`"${slot.column}" AS secret`);
      expect(db.calls[0]!.values).toEqual([null, 100]);
    }
  });

  it.each([
    ['unbekannte Tabelle', 'tenant', 'name'],
    ['unbekannte Spalte einer bekannten Tabelle', 'inbound_mailbox', 'host'],
    ['Prototyp-Schlüssel', '__proto__', 'secret_enc'],
    ['Object-Schlüssel', 'constructor', 'secret_enc'],
    ['Anführungszeichen im Tabellennamen', 'inbound_mailbox" WHERE true; --', 'secret_enc'],
    ['Anführungszeichen im Spaltennamen', 'inbound_mailbox', 'secret_enc" = \'\' OR "x'],
    ['Punkt im Tabellennamen', 'n8n_connection.api_key', 'encrypted'],
  ])('weist %s vor jeder Abfrage ab', async (_label, table, column) => {
    const db = recordingExecutor();
    await anwendungAbgewiesen(
      rewrapStoredSecrets(db, [{ name: 'fremd', slot: columnSlot(table, column) }], ops),
      'Nicht unterstützter Secret-Box-Ablageort',
    );
    expect(db.calls).toEqual([]);
  });
});
