# Kanonische SQL-Quellen für Funktionen, Trigger und Policies

Stand: 2026-10-06 · Anlass: Review-Finding D-01

Die Datenbanklogik (PL/pgSQL- und SQL-Funktionen, Trigger, RLS-Policies) entsteht
ausschließlich über Migrationen. Bisher war ihr aktueller Stand nur in der Datenbank
oder in der jüngsten von bis zu sieben Migrationen sichtbar, die dasselbe Objekt neu
definieren (`app.tax_notice_set_appeal_deadline` etwa in sieben, dazu ein
`ALTER FUNCTION`). Eine Änderung zeigte im Review nur den vollständigen neuen Text,
nicht den Unterschied zum alten.

Seit D-01 steht der Stand einer frisch migrierten Datenbank je Objekt als Datei unter
`packages/db/prisma/sql/`. Migrationen bleiben der einzige Weg, eine Datenbank zu
ändern; die Dateien sind ihr lesbarer Endstand. Ein CI-Gate erzwingt, dass beide
übereinstimmen. Eine Änderung beginnt deshalb an der kanonischen Datei, die Migration
wird daraus erzeugt, und der Review sieht den Diff der Datei.

## Aufbau

| Verzeichnis  | Datei                                  | Inhalt                                                                         |
| ------------ | -------------------------------------- | ------------------------------------------------------------------------------ |
| `functions/` | `<schema>.<name>(<argumenttypen>).sql` | `pg_get_functiondef`, abgeschlossen mit `;`                                    |
| `triggers/`  | `<tabelle>.<trigger>.sql`              | `pg_get_triggerdef`; ein abweichender Aktivierungszustand als `ALTER`          |
| `policies/`  | `<tabelle>.<policy>.sql`               | `CREATE POLICY` aus `pg_policies` mit `AS`, `FOR`, `TO`, `USING`, `WITH CHECK` |

- Erfasst werden die Schemas `app` und `public` ohne Objekte der Extensions
  (`pgcrypto`, `pg_trgm`, `citext`): Funktionen und Prozeduren, alle nicht internen
  Trigger einschließlich Constraint-Triggern und alle RLS-Policies. Tabellen außerhalb
  von `public` erhalten das Schema als Präfix im Dateinamen.
- Nicht erfasst werden Tabellen, Spalten, Constraints und Indizes (dafür
  `schema.prisma` und `pnpm verify:schema-drift`), RLS-Aktivierung (`pnpm verify:rls`),
  Eigentümer, `GRANT`/`REVOKE` und Kommentare. Aggregate und Fensterfunktionen gibt
  es nicht; der Dump bricht ab, falls eine solche Funktion entsteht.
- Funktionsrümpfe stehen wörtlich wie in der Migration. Kopfzeilen, Trigger und
  Policy-Ausdrücke sind die von PostgreSQL normalisierte Form: Klammern, Casts wie
  `'STAFF'::text` und qualifizierte Namen (`public.client`, `app.current_tenant_id()`).
- Der Dump läuft mit festen Sitzungseinstellungen (leerer `search_path`, ISO-Datum,
  UTC, `extra_float_digits = 3`) und ist damit unabhängig von Rolle und Client.
  Dateien sind normalisiert (LF, kein Leerraum am Zeilenende, genau ein Zeilenumbruch
  am Ende) und nach Codepunkten sortiert. Dateinamen enthalten keine
  Anführungszeichen oder Leerzeichen; Namen, die sich nur in der Groß-/Kleinschreibung
  unterscheiden, brechen den Dump ab.

## Befehle

Alle Befehle lesen `DATABASE_URL` (Owner-Verbindung) einer migrierten Datenbank.

| Befehl                  | Wirkung                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm db:sql:dump`      | schreibt den Stand der Datenbank nach `packages/db/prisma/sql/` und entfernt Dateien entfallener Objekte                                             |
| `pnpm db:sql:check`     | vergleicht Dateien und Datenbank; Exit 1 mit Diff (`-` Repository, `+` Datenbank) und bei Migrationen mit Gerüst-Platzhaltern, Exit 2 bei DB-Fehlern |
| `pnpm db:sql:migration` | erzeugt aus geänderten Dateien ein Migrationsgerüst (braucht keine Datenbank)                                                                        |

Das CI prüft im Job `db` direkt nach Migrationen, Ledger-Gate und GwG-Invarianten mit
`pnpm db:sql:check`.

## Eine Funktion, einen Trigger oder eine Policy ändern

1. Lokale Datenbank auf den aktuellen Stand migrieren (`pnpm db:migrate:deploy`);
   `pnpm db:sql:check` muss sauber sein.
2. Die kanonische Datei bearbeiten, neu anlegen oder löschen. Jede Datei enthält genau
   ein vollständiges Statement (`CREATE OR REPLACE FUNCTION …;`, `CREATE TRIGGER …;`,
   `CREATE POLICY …;`); ein Trigger mit abweichendem Aktivierungszustand zusätzlich
   das `ALTER TABLE … TRIGGER …;`.
3. Das Gerüst erzeugen:

   ```sh
   pnpm db:sql:migration --name tax_notice_appeal_deadline_x --rules TAX-NOTICE-APPEAL-001
   ```

   Ohne Dateiliste nimmt der Befehl alle Dateien unter `packages/db/prisma/sql/`, die
   sich gegenüber `--base` (Standard `HEAD`) geändert haben, einschließlich neuer und
   gelöschter. Er schreibt `packages/db/prisma/migrations/<UTC-Zeitstempel>_<name>/migration.sql`:
   - Kopfkommentar mit den Regel-IDs und der Liste der Quelldateien, `BEGIN;`/`COMMIT;`,
     LF. Ohne `--rules` schlägt er je Objekt die Regel-IDs der jüngsten Migration vor,
     die es definiert und Regel-IDs trägt (Kopfkommentar oder `code_refs` im
     Fachkatalog), und markiert sie zur Prüfung.
   - Reihenfolge: geänderte oder entfernte Trigger und Policies per `DROP` entfernen,
     Funktionen per `CREATE OR REPLACE` anlegen, Trigger und Policies neu anlegen,
     entfallene Funktionen zuletzt per `DROP FUNCTION` entfernen.
   - Geänderte Signatur oder geänderter Rückgabetyp werden mit einem Platzhalter
     markiert: `CREATE OR REPLACE` legt dann eine Überladung an bzw. schlägt fehl;
     abhängige Trigger und Policies sind zu prüfen.

   `--timestamp YYYYMMDDHHMMSS` setzt einen vorgegebenen Zeitstempel; er muss hinter der
   jüngsten vorhandenen Migration liegen. `--dry-run` gibt das Gerüst nur aus.

4. Das Gerüst ausfüllen: Anlass, Änderung und Verhalten beschreiben und alle
   Platzhalter `TODO(db:sql:migration)` entfernen; `pnpm db:sql:check` lehnt Migrationen
   mit Platzhaltern ab. Was das Gerüst nicht kennt, ergänzen (Datenänderungen,
   `GRANT`/`REVOKE`, neue Tabellen und Spalten samt `schema.prisma`).
5. Migrieren, dann `pnpm db:sql:dump` ausführen: Der Dump ersetzt die bearbeitete Datei
   durch PostgreSQLs Normalform (etwa zusätzliche Klammern in Policy-Ausdrücken).
   Danach `pnpm db:sql:check` und die passenden Tests.
6. Migration und Quelldateien im selben Commit einchecken. Die Fachkatalog-Pflichten
   aus `AGENTS.md` gelten unverändert; Migrationen sind überwachte Fachpfade
   (`pnpm fachkatalog:diff`).

Die Dateien selbst werden nie ausgeführt. Eine geänderte Datei ohne Migration fällt im
CI-Gate ebenso auf wie eine Migration ohne aktualisierte Datei.

**PostgreSQL-Hauptversion:** Die Normalform von Ausdrücken kann sich zwischen
Hauptversionen unterscheiden. Maßgeblich ist die Version aus CI und Produktion
(PostgreSQL 18, wie im Stack unter `infra/compose`). Den Dump mit dieser Version
erzeugen; meldet das CI-Gate nur Formunterschiede, behebt ein Dump gegen eine
PostgreSQL-18-Datenbank sie.

## Baseline der Migrationen (bedingt, noch nicht umgesetzt)

D-01 empfiehlt zusätzlich, die Migrationshistorie durch eine Baseline aus einem
Schema-Dump zu ersetzen und die Ledger-Sonderfälle (`KNOWN_*` in
`packages/db/scripts/migration-ledger.mjs`, die fünf Reparatur-Migrationen, die
03400-Recovery und den Known-Legacy-Drift-Test) zu entfernen. Das ist erst zulässig,
wenn **jede Installation und jede noch wiederherzustellende Sicherung mindestens auf
`20260827100000_reconcile_late_security_guards` steht**, ihr Ledger also alle
Migrationen bis dahin mit den Repository-Prüfsummen führt. Ob und wann das gilt, ist
eine Betriebs- und Release-Entscheidung; die Baseline ist deshalb nicht umgesetzt.

Vorgesehener Ablauf, sobald die Voraussetzung belegt ist:

1. **Mindeststand erzwingen:** Ein Release legt den Schnittpunkt C fest (jüngste
   Migration eines veröffentlichten Releases, mindestens `20260827100000`). Der
   Update-Pfad bricht vor `migrate deploy` ab, wenn das Ledger C nicht enthält, mit
   dem Hinweis, zuerst auf dieses Release zu aktualisieren.
2. **Baseline erzeugen:** Frische Datenbank bis C migrieren und
   `pg_dump --schema-only --no-owner` ohne `_prisma_migrations` erzeugen (Privilegien
   bleiben, sie gehören zum Sicherheitsmodell; Rollen und Extensions bleiben im
   Bootstrap). Ergebnis als eine Migration, die vor allen Migrationen nach C sortiert.
3. **Historie ersetzen:** Alle Migrationen bis C aus dem Repository entfernen (die
   Git-Historie bleibt), ebenso die Ledger-Sonderfälle, die 03400-Recovery, die
   Cutoff-Tests vor C (`scripts/ci/migration-cutoff.sh`) und den CI-Schritt „Known
   pre-release ledger drift upgrade“.
4. **Ledger-Übergang:** Bestehende Installationen führen die Baseline nicht aus. Ein
   einmaliger Schritt im Deploy-Pfad ersetzt in einer Transaktion die Ledger-Zeilen bis
   C durch eine Zeile für die Baseline (wie `prisma migrate resolve --applied`), aber
   nur, wenn alle Zeilen bis C mit den eingefrorenen Prüfsummen übereinstimmen; sonst
   Abbruch.
5. **Gleichwertigkeit nachweisen:** Im CI eine frische Installation (Baseline und
   spätere Migrationen) mit einer aktualisierten (alte Historie bis C, Übergang,
   spätere Migrationen) vergleichen: identischer Schema-Dump und sauberes
   `pnpm db:sql:check` auf beiden. Die kanonischen Quellen bleiben danach unverändert
   gültig.
6. **Sicherungen vor C:** Wiederherstellung nur über ein Release vor der Baseline, dort
   auf mindestens C aktualisieren und neu sichern; im Disaster-Recovery-Runbook
   festhalten.
