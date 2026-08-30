---
id: ACCESS-NOTIFICATION-RECIPIENT-001
title: Mandantenbezogene Mitarbeiterbenachrichtigungen nach aktuellem Zugriff filtern
domain: mandat-und-zugriff
rule_type: product_rule
jurisdiction: EU/DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Datenschutz und Kanzleiorganisation
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Die neue Notification-Scope-Migration bindet bekannte Fachressourcen
    fail-closed an einen Mandanten und erzwingt bei Staff-Lesen/-Mutieren den
    aktuellen Empfänger- und Clientzugriff. Reminder revalidieren Empfänger vor
    dem Insert; ein vollständiges Inventar aller Producer sowie Mail- und
    n8n-Austritte bleibt als Härtungsnachweis offen.
sources:
  - kind: product_documentation
    citation: Fachkatalog-Inventur, Notification-Empfänger und Zugriffshärtung
    path: docs/fachkatalog/SCOPE.md
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: Feature-Katalog, Empfängerfilter nach OPEN/RESTRICTED und Vertraulichkeit
    path: FEATURES.md
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 57 Abs. 1 StBerG
    url: https://www.gesetze-im-internet.de/stberg/__57.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 203 StGB
    url: https://www.gesetze-im-internet.de/stgb/__203.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: Art. 5 Abs. 1 Buchst. c und f, Art. 25 und 32 DSGVO
    url: https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=de
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - packages/db/src/staff-client-access.ts
  - packages/db/src/notification.ts
  - apps/worker/src/jobs/reminders-daily.ts
  - packages/db/prisma/migrations/20260823202000_notification_client_scope/migration.sql
  - packages/db/prisma/migrations/20260830234000_restore_portal_notification_write_only/migration.sql
test_refs:
  - apps/worker/src/jobs/__tests__/reminders-daily.test.ts
  - apps/web/src/app/staff/(protected)/notifications/__tests__/actions.test.ts
  - packages/db/src/__tests__/notification-client-scope-migration.test.ts
  - packages/db/src/__tests__/notification-client-scope-rls.test.ts
  - packages/db/src/__tests__/notification-write-only-forward.test.ts
feature_refs:
  - FEATURES.md
  - docs/development/module/zugriffsschutz.md
related_rules:
  - ACCESS-CLIENT-MODE-001
  - ACCESS-TENANT-RLS-001
tags:
  - notification
  - empfänger
  - vertraulichkeit
---

# ACCESS-NOTIFICATION-RECIPIENT-001 — Mandantenbezogene Mitarbeiterbenachrichtigungen nach aktuellem Zugriff filtern

## Kurzfassung

Eine alte Zuständigkeit darf nicht dauerhaft Zugang zu einem später
vertraulichen oder RESTRICTED-Mandanten vermitteln. Mandantenbezogene
Notifications werden daher an eine bekannte Fachressource und deren Mandanten
gebunden; Anzeige und Mutation verlangen den aktuellen Clientzugriff. Technisch
globale oder persönliche Systemmeldungen bleiben ein getrennter Scope.

## Wann gilt die Regel?

Die Regel gilt für Staff-Notifications mit klassifizierter Fachressource sowie
für Reminder, deren Empfänger aus Zuständigkeiten abgeleitet werden. Sie gilt
nicht als fachliche Zuständigkeitsregel für E-Mail, n8n oder andere
Kommunikationskanäle außerhalb des Notification-Modells.

## Benötigte Angaben

- Tenant und Notification
- Empfänger-ID oder bewusst kanzleiweiter Staff-Scope
- Ressourcentyp und Ressourcen-ID
- aus der Ressource abgeleiteter Mandant
- aktueller OPEN/RESTRICTED-/Vertraulichkeitsstand
- aktive Rolle oder Verantwortung des Empfängers

## Entscheidungslogik

| Wenn                                           | Dann                                                                      | Begründung                         |
| ---------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------- |
| bekannte mandantenbezogene Ressource           | `clientId` aus tenantgleicher Fachzeile ableiten                          | keine frei behauptete Zuordnung    |
| Ressourcentyp unbekannt oder Link halb gesetzt | Insert/Update verweigern                                                  | fail-closed Klassifikation         |
| gezielte Staff-Notification                    | nur dem aktuellen Empfänger zeigen                                        | persönliche Zustellung             |
| kanzleiweite mandantenbezogene Notification    | nur aktuell clientberechtigten Staff zeigen                               | Broadcast ohne Zugriffsaufweitung  |
| Empfänger verliert Zugriff                     | Lesen, Aktualisieren und Löschen sofort verweigern                        | aktueller statt historischer Scope |
| neutraler technischer Typ                      | nur in der expliziten Neutral-Allowlist ohne Client zulassen              | getrennte Systemdomäne             |
| Reminder wird erzeugt                          | Fachzeile sperren und Status, Empfängeraktivität sowie Zugriff neu prüfen | Race- und Zuständigkeitskontrolle  |

## Ausnahmen und Grenzfälle

`staffId = null` bedeutet nicht öffentlich, sondern kanzleiweit innerhalb der
aktiven und bei Clientbezug berechtigten Staff-Nutzer. Die Datenbankpolicy
schützt Anzeige und Mutation, verhindert aber nicht automatisch, dass ein
anderer Versandkanal zuvor falsche Empfänger ermittelt. Neue
Notification-Ressourcentypen müssen ausdrücklich klassifiziert werden.

## Beispiele

### Normalfall

Ein Fristenhinweis verweist auf einen Steuerbescheid. Die Migration leitet den
Mandanten aus dem Bescheid ab. Nur der adressierte und weiterhin berechtigte
Mitarbeiter kann die Notification lesen.

### Grenzfall

Nach Kandidatenermittlung wird der Mandant vertraulich und die alte
Bearbeiterzuordnung entfernt. Die Insert-Transaktion revalidiert die
Fachressource und der gemeinsame Accessfilter verwirft den alten Empfänger;
eine schon vorhandene Notification wird durch RLS unsichtbar.

## Umsetzung in TaxTronik

Die Migration ergänzt `client_id`, leitet sie über eine geschlossene Liste
bekannter Ressourcen ab, macht Scope und Ressourcenlink unveränderlich und
ersetzt die generische Notification-Policy durch getrennte SELECT/INSERT/
UPDATE/DELETE-Regeln. Der Reminder-Worker sperrt die aktuelle Fachzeile und
verwendet `filterStaffAccessClientTx` unmittelbar vor `createMany`.

Eine spätere Forward-Migration stellt nach der zusammengeführten historischen
Migrationsreihenfolge die Staff-/System-beschränkte `notification_insert`-Policy
wieder her. Die Reparatur vom 27. August installiert noch eine ältere Policy
mit direktem Portal-INSERT; sie darf den inzwischen geschlossenen write-only
Portalpfad nicht wieder öffnen. Die neue Migration ändert ausschließlich diese
INSERT-Policy. Historische Migrationsdateien, die validierende Portal-Funktion,
ihre Ereignisliste sowie SELECT-, UPDATE- und DELETE-Rechte bleiben unverändert.

## Bekannte Abweichungen und Grenzen

Der Status bleibt teilweise, weil noch kein vollständiges Inventar aller
heutigen Producer sowie Mail-/n8n-Austritte vorliegt. Die Migration und ihre
Replay-/DB-Regressionen sind technisch nachgewiesen. Die RLS-Schicht
klassifiziert nur die hinterlegte Fachressource; Freitexttitel und Body werden
nicht inhaltlich auf unnötige Geheimnisse geprüft.

## Fachliche Prüffragen

- Welche Notifications dürfen tatsächlich kanzleiweit statt gezielt sein?
- Sind alle mandantenbezogenen Ressourcentypen vollständig klassifiziert?
- Müssen E-Mail- und n8n-Pfade dieselbe aktuelle Revalidierung verwenden?
- Welche Freitextdaten sind in Titel und Body zulässig?

## Technische Nachweise

Migrations- und DB-Tests belegen Ableitung, unbekannte Typen, Empfänger-RLS und
sofortigen Entzug nach Vertraulichkeitsänderung. Worker-Tests belegen Locks,
Statusrevalidierung, aktive Empfänger und den gemeinsamen Clientfilter. Die
Nachweise sind noch kein vollständiges Producer-/Kanal-Inventar.

Der zusätzliche Forward-Replaytest spielt die ältere INSERT-Policy in einer
stets zurückgerollten Datenbanktransaktion ein und reproduziert den unerwünschten
Raw-INSERT. Nach Einspielen der Forward-Policy muss derselbe Zugriff scheitern,
während der validierende Portal-Upsert idempotent funktioniert. Portal-Lesen,
-Ändern und -Löschen bleiben gesperrt; der vorhandene Staff-/Systempfad bleibt
erhalten. Strukturtests sichern außerdem die abschließende Migrationsreihenfolge
und die unveränderte Policy aus dem write-only Portalpfad. Diese Regression
deckt die konkrete Merge-Reihenfolge ab, nicht das gesamte Producer-Inventar.
