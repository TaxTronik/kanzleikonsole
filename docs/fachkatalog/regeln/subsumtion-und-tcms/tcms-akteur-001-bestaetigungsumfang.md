---
id: TCMS-AKTEUR-001
title: Akteursbestätigungen an das Tax-CMS höchstens im Umfang des eigenen Mandantenzugriffs ausstellen
domain: subsumtion-und-tcms
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger TCMS und Kanzleiorganisation
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Die kanzleikonsole bestätigt dem Tax-CMS je Aufruf Person, Rollen und
    Mandantenbezug ausschließlich aus der geprüften Sitzung und dem aktuellen
    Datenbestand; ohne Mandantenzugriff nach ACCESS-CLIENT-MODE-001 entsteht
    keine Bestätigung und kein Aufruf. Seiten und Aktionen der Oberflächen
    nutzen dafür zentrale Helfer; Personen aus Formularen werden gegen den
    Mandanten geprüft. Die fachliche Freigabe der Abbildungstabelle steht aus.
sources:
  - kind: product_documentation
    citation: Anbindung des Tax-CMS, Abschnitt 4 (Akteursabbildung) und Abschnitt 7 (Oberflächen)
    path: docs/development/tcms-anbindung.md
    checked_at: '2026-10-19'
    primary: true
  - kind: product_documentation
    citation: Leitfaden Tax-CMS-Oberflächen
    path: docs/development/tcms-oberflaechen.md
    checked_at: '2026-10-19'
    primary: false
  - kind: product_documentation
    citation: Anwenderdokumentation Tax-CMS
    path: docs/anwenderdoku/tax-cms.md
    checked_at: '2026-10-19'
    primary: false
code_refs:
  - apps/web/src/server/tcms/akteur.ts
  - apps/web/src/server/tcms/seite.ts
  - apps/web/src/server/tcms/aktion.ts
  - apps/web/src/server/tcms/personen.ts
  - apps/web/src/server/tcms/namen.ts
  - apps/web/src/server/tcms/mandant.ts
  - apps/web/src/server/tcms/feststellungen/personen.ts
  - apps/web/src/server/tcms/programm/zustaendigkeit.ts
  - apps/web/src/server/tcms/programm/einrichtung.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/einrichtung/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/profil/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/beschreibung/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kommunikation/actions.ts
  - apps/web/src/server/tcms/bereich-b/personen-auswahl.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/risiken/actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kontrollen/actions.ts
  - apps/web/src/server/tcms/ereignisse/personen.ts
  - apps/web/src/server/tcms/abruf/einstieg.ts
test_refs:
  - apps/web/src/server/tcms/__tests__/seite.test.ts
  - apps/web/src/server/tcms/__tests__/aktion.test.ts
  - apps/web/src/server/tcms/__tests__/zustand.test.ts
  - apps/web/src/server/tcms/__tests__/namen-personen-db.test.ts
  - apps/web/src/server/tcms/__tests__/akteur-db.test.ts
  - apps/web/src/__tests__/client-page-authz.test.ts
  - apps/web/src/server/tcms/__tests__/mandant.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/__tests__/actions.test.ts
  - apps/web/src/server/tcms/feststellungen/__tests__/personen.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/feststellungen/__tests__/actions.test.ts
  - apps/web/src/server/tcms/programm/__tests__/zustaendigkeit-db.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/einrichtung/__tests__/aktionen.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/profil/__tests__/aktionen.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/beschreibung/__tests__/aktionen.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kommunikation/__tests__/aktionen.test.ts
  - apps/web/src/server/tcms/bereich-b/__tests__/personen-auswahl-db.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/risiken/__tests__/actions.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kontrollen/__tests__/actions.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/kontrollen/__tests__/seite.test.tsx
  - apps/web/src/components/tcms/kontrollen/__tests__/kontrollen.test.tsx
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/__tests__/ereignisse-aktionen.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tcms/__tests__/ereignisse-anlage-route.test.ts
feature_refs:
  - FEATURES.md
  - docs/anwenderdoku/tax-cms.md
related_rules:
  - ACCESS-CLIENT-MODE-001
  - ACCESS-TENANT-RLS-001
  - TCMS-DIENST-001
tags:
  - tcms
  - akteur
  - mandantenzugriff
  - bestätigung
---

# TCMS-AKTEUR-001 — Akteursbestätigungen an das Tax-CMS höchstens im Umfang des eigenen Mandantenzugriffs ausstellen

## Kurzfassung

Das Tax-CMS leitet seine Rechte (Lesen, Bearbeiten, §-153-Würdigung) aus einer
signierten Akteursbestätigung der kanzleikonsole ab. Die kanzleikonsole stellt
diese Bestätigung nur aus der geprüften Sitzung und dem aktuellen
Datenbestand aus und bestätigt nie mehr, als sie selbst gewährt: einen
Mandantenbezug nur bei Zugriff nach ACCESS-CLIENT-MODE-001, die Rolle
Admin/Partner nur bei aktuellem Rollenstand, Zuständigkeiten nur aus den
Zuordnungen des Mandanten. Ohne Bestätigung findet kein Aufruf statt.

## Wann gilt die Regel?

Die Regel gilt für jeden Aufruf des Tax-CMS aus der kanzleikonsole: Seiten
unter `/staff/tcms`, `/staff/clients/[id]/tcms` und `/portal/tcms`, Server
Actions dieser Bereiche und künftige Hintergrundaufgaben. Sie gilt nicht für
den Health-Check (nur Dienst-Token) und nicht für die Entscheidungen, die das
Tax-CMS auf Grundlage der Bestätigung trifft (siehe TCMS-DIENST-001).

## Benötigte Angaben

- geprüfte Sitzung (Kanzleiperson oder Mandantenkontakt) mit Tenant
- aktueller Rollenstand und Berufsträgereigenschaft der Person
- Mandant des Aufrufziels: aus dem Pfad erst nach der Zugriffsprüfung, im
  Portal ausschließlich aus der Sitzung
- Zuordnungen des Mandanten (Berufsträger, Hauptbearbeitung)
- bei Personen aus Formularen: die erlaubte Personenmenge des Mandanten

## Entscheidungslogik

| Wenn                                                                                      | Dann                                                                                                             | Begründung                                                           |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Kanzleiperson mit Zugriff auf den Mandanten (ACCESS-CLIENT-MODE-001)                      | Bestätigung mit `cli` = Mandant, `bt`/`hb` aus den aktuellen Zuordnungen                                         | höchstens der Umfang der eigenen Zugriffsregel                       |
| kein Zugriff, Mandant fremd oder nicht vorhanden                                          | keine Bestätigung, kein Aufruf; Seite „Kein Zugriff“ bzw. 404                                                    | keine Erweiterung über den Tenant- oder Mandantenzugriff hinaus      |
| Rollen der Sitzung weichen vom aktuellen Stand ab, Sitzung abgelaufen oder Person inaktiv | keine Bestätigung; Hinweis, sich erneut anzumelden                                                               | veraltete Rechte werden nicht bestätigt                              |
| `rol.adm`                                                                                 | nur für ADMIN oder PARTNER mit aktuellem Rollenstand                                                             | entspricht der Kanzleileitung in der kanzleikonsole                  |
| Portfolio oder Arbeitskorb                                                                | Mandantenliste wie die sichtbaren Mandanten der Person, höchstens 5 000, sonst keine Bestätigung                 | keine stille Kürzung, keine zusätzlichen Mandanten                   |
| Mandantenkontakt                                                                          | `cli` = Mandant der Portal-Sitzung, `bt`/`hb` falsch, nur mit aktivem Portalzugang                               | Portal nie mandantenübergreifend                                     |
| Person aus einem Formular (Verantwortliche, Kontaktrollen)                                | nur Mitarbeiter mit Zugriff auf den Mandanten bzw. Kontakte genau dieses Mandanten; Namen aus der kanzleikonsole | keine Daten eines anderen Mandanten, keine Namen aus Formularfeldern |

## Ausnahmen und Grenzfälle

Die Login-Sperre einer Person verhindert keine Bestätigung für eine bereits
laufende Sitzung; sie sperrt nur neue Passwort-Anmeldungen. Eine Zuordnung
als Berufsträger ohne (noch gültige) Berufsträgereigenschaft gewährt Zugriff,
aber nicht `bt`. Ein Kontakt eines anderen Mandanten wird in Antworten des
Tax-CMS nicht namentlich aufgelöst („Unbekannte Person“).

## Beispiele

### Normalfall

Eine Mitarbeiterin ohne Zuordnung öffnet im Zugriffsmodell OPEN das Cockpit
eines nicht vertraulichen Mandanten. Die Bestätigung enthält den Mandanten
mit `bt` und `hb` falsch; das Tax-CMS zeigt die Daten zum Lesen.

### Grenzfall

Derselbe Mandant wird vertraulich gesetzt, während die Seite offen ist. Der
nächste Aufruf bestätigt keinen Mandantenbezug mehr; die Seite zeigt „Kein
Zugriff“, eine Aktion endet mit derselben festen Meldung, ohne das Tax-CMS zu
fragen.

## Umsetzung in TaxTronik

`apps/web/src/server/tcms/akteur.ts` bildet die Bestätigung (Stufe 2).
Seiten nutzen ausschließlich `tcmsMandantSeite`, `tcmsKanzleiSeite`,
`tcmsAdminSeite` oder `tcmsPortalSeite` (`server/tcms/seite.ts`): Zugriffs-
und Modulprüfung zuerst, dann in einer Tenant-Transaktion Aktivierung und
Akteur. Lesezugriffe setzen Mandant, Akteur und Mandantenliste aus der Seite;
eine Seite kann sie nicht überschreiben. Aktionen nutzen `tcmsKanzleiAktion`
bzw. `tcmsPortalAktion` (`server/tcms/aktion.ts`) mit demselben Ablauf.
Personen aus Formularen prüft `server/tcms/personen.ts`, Namen in Antworten
löst `server/tcms/namen.ts` nur im Tenant bzw. beim Mandanten auf. Name,
Rechtsform und DATEV-Nummer des Mandantenankers stammen aus
`server/tcms/mandant.ts` (Mandant und verifizierte GwG-Prüfung), nie aus dem
Formular.

## Bekannte Abweichungen und Grenzen

Die Abbildungstabelle ist fachlich nicht freigegeben. Hintergrundaufgaben des
Workers rufen das Tax-CMS noch nicht auf; für sie fehlt eine eigene Regel zur
Bestätigung ohne Sitzung. Die Oberflächen der übrigen Bereiche (Einrichtung,
Risiken, Kontrollen, Durchführungen, Feststellungen, Ereignisse, Länder,
Beschreibung, Kommunikation, Audit) folgen in weiteren Schritten mit denselben
Helfern.

## Fachliche Prüffragen

- Entspricht die Gleichsetzung von ADMIN und PARTNER als Kanzleileitung der
  Organisation der Kanzlei?
- Genügt die Zuordnung BERUFSTRAEGER mit aktueller Berufsträgereigenschaft als
  „zuständige Berufsträgerin“ für §-153-Würdigungen im Tax-CMS?
- Sollen Kontakte ohne Portalzugang Rollen im Tax-CMS erhalten können?

## Technische Nachweise

`seite.test.ts` belegt Reihenfolge und Bindung der Seiten-Helfer,
`aktion.test.ts` die der Aktions-Helfer, `zustand.test.ts` die festen
Meldungen bei Verweigerung. `namen-personen-db.test.ts` prüft gegen
PostgreSQL Namensauflösung und Personenprüfung, `akteur-db.test.ts` die
Akteursabbildung selbst. `client-page-authz.test.ts` erzwingt den
Zugriffs-Guard als ersten Aufruf auch im Tax-CMS-Helfer. `actions.test.ts`
belegt, dass die Aktionen den gebundenen Mandanten statt Formularwerten
verwenden, `mandant.test.ts` die Bereinigung der Ankerfelder.
