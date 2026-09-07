---
id: GWG-RETENTION-DESTRUCTION-001
title: GwG-Aufzeichnungen fristgerecht aufbewahren und vollständig vernichten
domain: gwg
rule_type: statute
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
  summary: >-
    TaxTronik berechnet Fünf- und Zehnjahresstichtage, schützt Dateiobjekte und
    bietet eine manuell bestätigte zweistufige Vernichtung. Die
    Zehnjahresgrenze wird jedoch nicht automatisch durchgesetzt; außerdem
    bleiben minimale Skelett- und Auditdaten bestehen, deren weitere
    Rechtsgrundlage und Löschfrist fachlich noch nicht geklärt sind.
sources:
  - kind: official_law
    citation: § 8 Abs. 1 bis 5 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__8.html
    checked_at: '2026-08-24'
    primary: true
code_refs:
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/page.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/gwg-page-model.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/gwg-page-status.tsx
  - packages/db/prisma/migrations/20260831260000_gwg_structure_binding/migration.sql
  - apps/web/src/server/gwg/retention.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/id-document-actions.ts
  - apps/web/src/app/staff/(protected)/admin/gwg-retention/actions.ts
  - apps/worker/src/jobs/gwg-expiry-check.ts
  - packages/storage/src/service.ts
  - packages/db/prisma/migrations/20260801004300_gwg_identity_subjects_and_document_sets/migration.sql
  - packages/db/prisma/migrations/20260823170000_gwg_open_first_check_retention/migration.sql
  - packages/db/prisma/migrations/20260824213000_gwg_evidence_supersession/migration.sql
  - packages/db/prisma/migrations/20260831101000_gwg_person_links/migration.sql
test_refs:
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/page-render.test.tsx
  - apps/web/src/server/mandate-expansion/__tests__/service-db.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
  - packages/db/src/__tests__/gwg-destruction.test.ts
  - packages/db/src/__tests__/gwg-person-links.test.ts
  - apps/web/src/server/gwg/__tests__/retention.test.ts
  - apps/web/src/app/staff/(protected)/admin/gwg-retention/__tests__/actions.test.ts
  - apps/worker/src/jobs/__tests__/gwg-expiry-check.test.ts
feature_refs:
  - FEATURES.md
  - docs/compliance/gwg.md
  - docs/anwenderdoku/dokumente.md
related_rules:
  - MANDATE-STRUCTURE-001
  - GWG-IDENTIFICATION-EVIDENCE-001
  - GWG-BENEFICIAL-OWNERS-001
  - GWG-SELF-ONBOARDING-001
  - GWG-PERSON-LINKS-001
tags:
  - aufbewahrung
  - vernichtung
  - zehnjahresgrenze
  - object-lock
---

# GWG-RETENTION-DESTRUCTION-001 — GwG-Aufzeichnungen fristgerecht aufbewahren und vollständig vernichten

## Kurzfassung

GwG-Aufzeichnungen und -Belege sind grundsätzlich fünf Jahre aufzubewahren,
soweit andere gesetzliche Vorschriften nicht länger verpflichten, und
spätestens nach zehn Jahren zu vernichten. Bei einer Geschäftsbeziehung beginnt
die Frist mit dem Schluss des Kalenderjahres ihres Endes, in übrigen Fällen mit
dem Schluss des Jahres der jeweiligen Feststellung.

TaxTronik unterstützt diese Kontrolle durch einen geschützten GwG-Bucket, eine
Review-Queue und eine zweistufige Vernichtung von Dateiobjekten und
Datenbankaufzeichnungen. Der derzeitige Stand unterstützt den Ablauf nur
teilweise und darf nicht als vollständige §-8-Erfüllung ausgegeben werden.

## Wann gilt die Regel?

Die Regel gilt für die nach § 8 GwG aufzuzeichnenden Identitäts-,
Berechtigten-, Risiko-, Geschäftsbeziehungs- und Transaktionsinformationen
sowie die dazugehörigen Belege. Im Produkt betrifft sie insbesondere
`GWG_EVIDENCE`, GwG-Prüfsnapshots, wirtschaftlich Berechtigte,
Vertreterdatensätze, Identitätsdokumente und Onboarding-Einladungsdaten.

Andere gesetzliche Aufbewahrungspflichten müssen je Datensatz geprüft werden.
Die Produktklassifikation `GWG_EVIDENCE` entscheidet nicht allein, welche Norm
im konkreten Fall die zulässige oder erforderliche Speicherdauer bestimmt.

## Benötigte Angaben

- Art und Inhalt der Aufzeichnung oder des Belegs
- Datum der jeweiligen Feststellung
- ob und wann eine Geschäftsbeziehung begründet wurde
- verlässliches Ende der Geschäftsbeziehung beziehungsweise `mandateEndedAt`
- andere gesetzliche Aufbewahrungsgründe
- regulärer Fünfjahresstichtag und absolute Zehnjahresgrenze
- Object-Lock-Ende jeder physischen Version
- offene Referenzen aus Prüfungen, Einladungen und Identitätsdatensätzen
- berechtigter bestätigender Mitarbeiter und Auditnachweis

## Entscheidungslogik

| Wenn                                                                              | Dann                                                                                  | Begründung                             |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------- |
| Geschäftsbeziehung wurde beendet                                                  | Fristbeginn ist der Schluss dieses Kalenderjahres                                     | § 8 Abs. 4 GwG                         |
| Keine Geschäftsbeziehung kam zustande                                             | Fristbeginn ist der Schluss des Jahres der jeweiligen Feststellung                    | Übriger Fall nach § 8 Abs. 4 GwG       |
| Fünf Jahre sind noch nicht vollständig abgelaufen                                 | Vernichtung blockieren                                                                | Mindestaufbewahrung                    |
| Andere gesetzliche Pflicht verlangt längere Aufbewahrung                          | Bis zu deren Ende aufbewahren, absolute Zehnjahresgrenze fachlich prüfen              | Kollisionsprüfung erforderlich         |
| Reguläre Frist ist abgelaufen                                                     | Eintrag in manuelle Review-Queue aufnehmen                                            | Kontrollierte Vernichtungsentscheidung |
| Zehnjahresgrenze ist erreicht                                                     | Späteste Vernichtung ist fällig                                                       | § 8 Abs. 4 Satz 2 GwG                  |
| Datei-Beleg ist fällig, Object Lock abgelaufen und keine neue Referenz entstanden | Vernichtungsabsicht committen, exakte Objektversionen löschen und DB-Abschluss setzen | Zweiphasige physische Vernichtung      |
| Noch ein nicht vernichteter Datei-Beleg zum Check existiert                       | Vernichtung der strukturierten Check-Aufzeichnungen blockieren                        | Reihenfolge und Nachweisbezug          |
| Alle Datei-Belege sind vernichtet und DB-Fristprüfung besteht                     | Personen- und Inhaltsdaten des Checks vernichten; Abschluss protokollieren            | Zweite Vernichtungsstufe               |

## Ausnahmen und Grenzfälle

- Ohne gepflegtes Mandatsende kann die Software das Ende einer tatsächlich
  beendeten Geschäftsbeziehung nicht erkennen.
- Bei einer nie zustande gekommenen Beziehung können unterschiedliche Angaben
  zu verschiedenen Zeiten festgestellt worden sein. Der aktuelle
  Aggregatansatz verwendet konservative Sammelzeitpunkte und bildet nicht jede
  Einzelaufzeichnung mit eigener Frist ab.
- Ein während einer laufenden Beziehung alter Beleg wird nicht allein wegen
  seines Alters löschreif; der Fristbeginn wartet grundsätzlich auf das
  Beziehungsende.
- Object Lock verhindert nur verfrühte Byte-Löschung. Die rechtliche
  Fristprüfung muss unabhängig davon stattfinden.
- Andere Rechtsgrundlagen können längere Speicherung verlangen; ob und wie sie
  mit der absoluten GwG-Vernichtungspflicht zusammenwirken, ist fachlich zu
  prüfen.

## Beispiele

### Normalfall

Das Mandat endet am 15. März 2026. Die Fünfjahresfrist läuft ab dem Schluss des
Jahres 2026; die Review-Queue darf ab dem 1. Januar 2032 eine Vernichtung
zulassen. Zuerst werden alle physischen Versionen der GwG-Belege kontrolliert
vernichtet, danach die personenbezogenen Check-Aufzeichnungen.

### Grenzfall

Ein Self-Onboarding wird 2026 begonnen, aber nie zu einer Geschäftsbeziehung.
Die Angaben wurden zuletzt 2027 ergänzt. Die konkrete Feststellung und damit
der Fristbeginn müssen je Aufzeichnung bestimmt werden. TaxTronik verwendet für
den Check einen konservativen letzten Aggregatzeitpunkt; das ersetzt keine
fachliche Einzelprüfung.

## Umsetzung in TaxTronik

Ein mit `destroyedAt` markiertes Prüfskelett erscheint in der Staff-Einzelprüfung ausdrücklich als vernichtet. Historische Status-/Verlaufsdaten begründen keinen grünen Freigabehinweis und keinen Onboarding-Fortsetzungslink. Personen-, Register-, Nachweis-, Risiko-, Einladungs- und Entscheidungsbereiche werden nicht aus dem Skelett oder aktuellen Mandantenstammdaten rekonstruiert. Der vorhandene Start eines neuen Zyklus bleibt für terminale Status erhalten; die bestehende Kopierlogik übernimmt aus vernichteten Quellen keine Identifizierungsdaten. Für nichtterminale vernichtete Skelette wird keine zusätzliche Wiederaufnahmeentscheidung eingeführt.

`retention.ts` berechnet den regulären Stichtag als 1. Januar nach fünf vollen
Kalenderjahren und eine entsprechende Zehnjahresgrenze. Beendete Mandate und
nie etablierte Erstprüfungen erscheinen in einer Admin-Review-Queue; ein
täglicher Worker erinnert Admins und Partner. Es gibt bewusst kein stilles
Auto-Delete.

Dateien liegen als `GWG_EVIDENCE` in einem eigenen Bucket mit Governance Object
Lock. Die Action committtet zuerst eine Vernichtungsabsicht, lädt danach die
gesperrte Versionsliste neu, löscht jede konkrete Storage-Version und setzt
einen DB-Abschluss. Erst anschließend darf eine SECURITY-DEFINER-Funktion die
strukturierten Checkdaten bereinigen. Datenbankprüfungen und Lifecycle-Locks
sollen zu frühe oder konkurrierende Vernichtung verhindern.

Beim Ersetzen eines Nachweises bleibt die abgelöste Prüfzuordnung ausdrücklich
als historische `GwgIdDocument`-Zeile erhalten. Das Lösen einer irrtümlichen
Zuordnung entfernt dagegen nur diese Verknüpfungszeile; das Dokument und seine
Object-Store-Versionen verbleiben bis zum kontrollierten Vernichtungspfad in
der Mandantenakte.

Technische mandatsübergreifende Personenverbindungen werden bei Anonymisierung
des Mandanten getrennt. Beim Abschluss der kontrollierten GwG-Vernichtung
entfallen Verbindungen zu lokalen Personenankern ohne lebende Prüfreferenz;
vollständig unreferenzierte Anker werden gelöscht. Noch aufzubewahrende
Fachsnapshots werden allein durch diese Bereinigung nicht verändert. Die
Verbindungen speichern keine gemeinsamen Namen, Ausweise oder Freigaben.

## Bekannte Abweichungen und Grenzen

- Die Zehnjahresgrenze wird nur in der Queue hervorgehoben. Bleibt die manuelle
  Entscheidung aus, vernichtet TaxTronik die Daten nicht spätestens zu diesem
  Zeitpunkt.
- Der Check-Skelettdatensatz behält unter anderem Status, Risikostufe/-score,
  Gültigkeits- und Freigabedaten sowie Personalreferenzen; auch der
  insert-only Auditnachweis bleibt dauerhaft. Ob und in welchem Umfang diese
  Restdaten selbst von § 8 Abs. 4 GwG erfasst sind oder eine andere Grundlage
  tragen, ist nicht fachlich geklärt.
- Fristen werden auf Aggregat- statt Einzelaufzeichnungsebene berechnet.
- Die physische Löschung aus Backups und wiederhergestellten Altständen ist
  kein Bestandteil des interaktiven Vernichtungspfads.

Der Implementierungsstatus ist deshalb **teilweise**.

## Fachliche Prüffragen

- Welche minimalen Vernichtungsnachweise dürfen nach der Zehnjahresgrenze noch
  bestehen bleiben und auf welcher Rechtsgrundlage?
- Wie werden konkurrierende längere Aufbewahrungspflichten dokumentiert und
  aufgelöst?
- Muss die Zehnjahresgrenze technisch erzwingbar sein, statt nur zu erinnern?
- Braucht jede Einzelaufzeichnung einen eigenen Feststellungs- und Fristbeginn?
- Wie werden Backups, Replikate und Auditdaten in die vollständige Vernichtung
  einbezogen?
- Wer bestätigt und kontrolliert `mandateEndedAt`?

## Technische Nachweise

`page-render.test.tsx`: Gerenderte Regressionen decken vernichtete VERIFIED-, DRAFT- und IN_REVIEW-Skelette sowie verbliebene Vertreter-/WB-/Dokumentdaten ab: keine Bearbeitungs- oder Freigabebereiche und keine erneut sichtbaren Personen-/Dokumentdetails.

Retention-Helfer und Tests belegen die Datumsberechnung, laufende Beziehungen,
nie etablierte Onboardings und die Queue. Action- und DB-Tests prüfen
Object-Lock, zweiphasigen Claim, konkrete Storage-Versionen, Tenant- und
Fristgrenzen sowie die geplante Bereinigung von Personen- und Checkdaten. Der
DB-Test bestätigt dabei auch, dass der kontrollierte
`destroyed_at`-Übergang über den zugehörigen Purge-Trigger die stabilen
Vertreterdatensätze entfernt. Nicht technisch nachgewiesen ist, dass die
verbleibenden Minimal- und Auditdaten fachlich über die absolute Grenze hinaus
gespeichert werden dürfen.

### Ergänzung: GwG-Bindung einer allgemeinen Mandatsstruktur

Beim bestehenden kontrollierten destroyed_at-Übergang des GwG-Checks löst ein Trigger die Referenz auf die separat geführte allgemeine Strukturversion und entfernt den gebundenen Hash und Übernahmevermerk. Der minimale Bindungsnachweis behält Prüfreferenz, Übernahmerevision, handelnde Person sowie Erstellungs- und Vernichtungszeit; deren weitere Aufbewahrung bleibt Teil der oben beschriebenen offenen Skelett-/Auditfrage. Es entsteht kein neuer Löschscheduler, keine Wiederherstellung gelöschter Bindungsinhalte und keine pauschale Vernichtung der eigenständig geführten allgemeinen Mandatsstruktur.
