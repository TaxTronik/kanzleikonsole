---
id: GWG-SCREENING-001
title: Lokale EU-Namenshinweise und manuelle PEP-Nachweise von GwG-Freigaben trennen
domain: gwg
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Geldwäscheprävention
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: Lokale EU-Liste und dokumentierte PEP-Recherchen erzeugen unveränderliche Nachweise. Bei aktiviertem Modul ist eine neue GwG-Freigabe an aktuelle Quelle, aktuelle GwG-Fassung und vollständig geklärte personenbezogene Nachweise gebunden. Bestehende Freigaben bleiben unverändert.
sources:
  - kind: official_guidance
    citation: 'Europäische Kommission: konsolidierte Liste der Personen, Gruppen und Organisationen unter EU-Finanzsanktionen'
    url: https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions?locale=en
    checked_at: '2026-08-31'
    primary: true
  - kind: product_documentation
    citation: Technische Modulbeschreibung und Betriebsgrenzen
    path: docs/development/module/screening.md
    checked_at: '2026-08-31'
    primary: true
code_refs:
  - packages/tax/package.json
  - packages/tax/src/screening/core.ts
  - packages/tax/src/screening/source.ts
  - packages/tax/src/screening/persistence.ts
  - apps/web/src/server/screening/service.ts
  - apps/web/src/server/screening/gwg-gate.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/screening/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/actions.ts
  - apps/worker/src/jobs/sanctions-refresh.ts
  - packages/db/prisma/migrations/20260831130000_screening_fees/migration.sql
test_refs:
  - packages/db/src/__tests__/screening-fees-rls.test.ts
  - packages/tax/src/screening/screening.test.ts
  - packages/tax/src/screening/persistence.test.ts
  - apps/web/src/server/screening/__tests__/gwg-gate.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
feature_refs:
  - docs/development/module/screening.md
related_rules:
  - GWG-RISK-REVIEW-001
  - ACCESS-TENANT-RLS-001
  - ACCESS-CLIENT-MODE-001
tags:
  - feature-erweiterung
  - ungepruefter-entwurf
---

# GWG-SCREENING-001 — Lokale EU-Namenshinweise und manuelle PEP-Nachweise von GwG-Freigaben trennen

## Kurzfassung

Ein Namensabgleich ist keine rechtliche Feststellung einer Sanktionsbetroffenheit.
Die lokale EU-Liste liefert Kandidaten; PEP-Recherchen werden manuell belegt.
Prüfläufe und Beurteilungen werden angehängt, nicht überschrieben.

## Wann gilt die Regel?

Nur bei aktiviertem Modul `sanctionsScreening` (standardmäßig aus).
Eine neue GwG-Freigabe setzt dann vollständige, an die aktuelle IN_REVIEW-Fassung
gebundene Nachweise voraus. Bereits verifizierte Checks werden nicht verändert.

## Benötigte Angaben

Offizieller Datenstand mit Hash, Publikationsdatum und erfolgreichem Abruf;
Person/Firma, Rolle, ggf. Geburtsdatum. Für freigaberelevante Nachweise sind
GwG-Check-ID, Snapshot-Hash und stabile Ziel-ID Pflicht. Die Zielmenge umfasst
Mandant/Gesellschaft, sämtliche Vertreter und wirtschaftlich Berechtigten.
Bei natürlichen Personen zusätzlich PEP-Ergebnis, Begründung und Quellen-URL.

## Entscheidungslogik

| Situation                                                        | Produktverhalten                                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Modul aus                                                        | Bestehender GwG-Freigabepfad bleibt unverändert; kein EU-Abruf                               |
| Fehlerhafter Abruf oder über 48 Stunden ohne erfolgreichen Abruf | Letzter gültiger Bestand bleibt, neue Abgleiche und neue Freigabe gesperrt                   |
| Gleicher Quellhash                                               | Erfolgreicher Abruf aktualisiert Zeitstempel ohne Snapshotduplikat                           |
| Namensähnlichkeit mindestens 0,82 oder exakt bei kurzem Namen    | Kandidaten, ggf. Geburtsdatenkonflikt, niemals automatische Freigabe                         |
| Neue Quellversion                                                | Eigenständige idempotente Folgeläufe und interne Hinweise                                    |
| Fehlende/alte/freie statt gebundener Nachweise                   | Neue GwG-Freigabe gesperrt                                                                   |
| Kandidaten ungeklärt/bestätigt oder gekürzt                      | Neue GwG-Freigabe gesperrt; alle Hinweise müssen geklärt sein                                |
| PEP-Hinweis gefunden                                             | Bestehende Risikologik muss HIGH und PEP-Antwort enthalten; veränderte Fassung erneut prüfen |
| Vollständige aktuelle Nachweise                                  | Bestehende explizite Berufsträgerentscheidung bleibt zusätzlich erforderlich                 |

## Ausnahmen und Grenzfälle

Ein manuell ungeklärter oder bestätigter Sanktionshinweis blockiert auch bei
zuvor null maschinellen Namenskandidaten. Widersprüchliche Ergebnisstrukturen
gelten nicht als erfolgreicher Prüfnachweis.

Ein Geburtsdatenwiderspruch entfernt einen Namenskandidaten nicht.
100 Kandidaten ist nur eine Anzeigegrenze, kein abgeschlossener Prüfumfang.
Freie manuelle Nachweise zählen nicht zur GwG-Abdeckung. Änderungen an relevanten
GwG-Daten entwerten die Bindung, erhalten aber alte Nachweise.
Die fachliche Verwendbarkeit eines unveränderten EU-Datenstands wird nicht allein
aus dem Alter seines Veröffentlichungsdatums abgeleitet.

## Beispiele

### Normalfall

Zur eingereichten GwG-Fassung einer GmbH werden die Gesellschaft und jede
hinterlegte natürliche Person separat abgeglichen; natürliche Personen erhalten
zusätzlich dokumentierte PEP-Recherchen. Ohne ungeklärte Hinweise kann der
berechtigte Berufsträger die unveränderte Fassung ausdrücklich entscheiden.

### Grenzfall

Ein späterer EU-Abruf scheitert. Der alte Bestand und ein früherer VERIFIED-Check
bleiben unverändert, eine neue Prüfung kann jedoch nicht abgeschlossen werden.

## Umsetzung in TaxTronik

Die lokale Quellen- und Matchinglogik liegt im Tax-Paket, die Webadapter unter
server/screening. Die neue Freigabesperre läuft im bestehenden Lifecycle-Lock vor
dem VERIFIED-Claim; Quelle und Modulkonfiguration werden in derselben
Transaktion stabil gelesen. Beurteilungen und automatische Folgeläufe verwenden
denselben Mandatslock. Es gibt keine automatische Änderung von GwG-Risikofeldern.
Tenant-RLS und zusammengesetzte Fremdschlüssel schützen neue Nachweise.

## Bekannte Abweichungen und Grenzen

Nicht enthalten sind vollständige Transliteration, Eigentums-/Kontrollprüfung,
andere Sanktionsregime oder eine PEP-Datenbank. Kein Treffer ist keine Unbedenklichkeit.
Die zusätzliche Nachweisablage ist noch nicht in den allgemeinen Löschlauf
integriert; vor produktiver Aktivierung ist ein beruflich freigegebenes
Aufbewahrungs-/Löschkonzept erforderlich. Schwellen und Sperren sind
Produktregeln und bleiben fachlich ungeprüft. Die neue Abdeckungssperre liegt im
Anwendungs-Freigabepfad; sie ersetzt keine organisatorische Kontrolle.

## Fachliche Prüffragen

Sind Datenquelle, Schwellen, Namensvarianten und Trefferbearbeitung angemessen?
Welche Maßnahmen erfordern bestätigte Sanktionstreffer? Wie werden PEP-Quellen
und notwendige Folgepflichten beurteilt? Welcher Aufbewahrungs-/Löschpfad ist für
die neuen Nachweise freizugeben?

## Technische Nachweise

Parser-/Matcher-Tests, Quellschutz-/Idempotenztests, aktuelle Personen-/Fassungs-
Gate-Tests und ein Action-Test zeigen die Sperre vor dem VERIFIED-Claim.
Echte PostgreSQL-Tests führen die Produktions-Quellenablage und idempotente
Folgeläufe mit allen Advisory-Locks über den Prisma-Adapter aus. Locks werden
ohne Deserialisierung des PostgreSQL-Rückgabetyps `void` ausgeführt.
Die verlinkte Modulbeschreibung dokumentiert Datenwege und Grenzen.
