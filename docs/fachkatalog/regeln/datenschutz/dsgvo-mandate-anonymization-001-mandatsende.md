---
id: DSGVO-MANDATE-ANONYMIZATION-001
title: Personenbezogene Mandatsdaten nach manueller Fristenprüfung anonymisieren
domain: datenschutz
rule_type: professional_interpretation
jurisdiction: EU/DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Datenschutz und Berufsrecht
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Für natürliche Personen erzeugt TaxTronik nach Mandatsende plus pauschal
    zehn Jahren ab Jahresende eine manuelle Review-Queue; Gesellschafts-PoA-
    Personendaten besitzen einen getrennten Redaktionspfad. Fallbezogene
    Fristen, Legal Holds und die Berufsträgerqualifikation der ausführenden
    Rolle werden nicht vollständig geprüft.
sources:
  - kind: official_law
    citation: Art. 5 Abs. 1 Buchst. e sowie Art. 17 Abs. 1 und 3 DSGVO
    url: https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=de
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: § 66 Abs. 1, 2 und 4 StBerG
    url: https://www.gesetze-im-internet.de/stberg/__66.html
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: DSGVO-Konzept, Mandanten-Anonymisierung nach Fristablauf
    path: docs/compliance/dsgvo-konzept.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/dsgvo/client-retention.ts
  - apps/web/src/server/dsgvo/anonymize-client-data.ts
  - apps/web/src/app/staff/(protected)/admin/dsgvo-retention/actions.ts
test_refs:
  - apps/web/src/server/dsgvo/__tests__/client-retention.test.ts
  - apps/web/src/app/staff/(protected)/admin/dsgvo-retention/__tests__/poa-signer-actions.test.ts
  - apps/web/src/app/staff/(protected)/admin/dsgvo-retention/__tests__/tax-data-actions.test.ts
  - apps/web/src/server/tax-master-data/__tests__/service.test.ts
  - packages/db/src/__tests__/poa-signing-integrity.test.ts
feature_refs:
  - docs/compliance/dsgvo-konzept.md
related_rules:
  - DSGVO-OPERATIONAL-RETENTION-001
  - DOC-RETENTION-CLASS-001
  - TAX-MASTER-DATA-001
tags:
  - anonymisierung
  - mandatsende
  - handakte
---

# DSGVO-MANDATE-ANONYMIZATION-001 — Personenbezogene Mandatsdaten nach manueller Fristenprüfung anonymisieren

## Kurzfassung

TaxTronik stellt personenbezogene Mandatsdaten nicht automatisch frei zur
Anonymisierung. Für natürliche Personen erscheint nach dem dokumentierten
Mandatsende und einem pauschalen Zehnjahresfenster ab Jahresende ein
Prüfvorschlag; die Ausführung bleibt ein manueller Admin-/Partner-Schritt.
Dieser Vorschlag ersetzt weder die aktenbezogene Prüfung des § 66 StBerG noch
weitere Aufbewahrungs-, Herausgabe-, Anspruchs- oder Beweisgründe.

## Wann gilt die Regel?

Der Hauptpfad gilt für Mandanten der Art `NATPERS` mit dokumentiertem
Mandatsende, die noch nicht anonymisiert sind. Für juristische Personen und
Personengesellschaften wird nicht die Gesellschaft anonymisiert; dort kann
nach demselben Zeitfenster ein getrennter Pfad noch vorhandene personenbezogene
Vollmachtsangaben redigieren. GoBD-, Steuer- und GwG-Objekte folgen ihren
eigenen Aufbewahrungs- und Vernichtungsregeln.

## Benötigte Angaben

- Mandantenart und tatsächliches Mandatsende
- vollständige Akten- und Dokumentenklassifikation
- offene Herausgabeverlangen, Verfahren, Ansprüche und Beweiszwecke
- Stand sämtlicher Steuer-, Handels- und GwG-Fristen
- bereits vernichtete GwG-Belege und -Aufzeichnungen
- verantwortliche prüfende und ausführende Person

## Entscheidungslogik

| Wenn                                                                      | Dann                                                                                                 | Begründung                                                                  |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Mandatsende fehlt                                                         | keinen Anonymisierungsvorschlag erzeugen                                                             | Fristanker fehlt                                                            |
| natürliche Person, Mandatsende-Jahr plus zehn Jahre noch nicht abgelaufen | nicht in Review-Queue aufnehmen                                                                      | pauschaler Produktschutzzeitraum                                            |
| natürliche Person nach Produktstichtag                                    | als manuell zu prüfenden Kandidaten anzeigen                                                         | noch keine Löschfreigabe                                                    |
| offene GwG-Objekte bestehen                                               | Anonymisierung blockieren                                                                            | eigener Vernichtungs- und Nachweispfad                                      |
| manuelle Bestätigung gelingt                                              | Stammdaten und definierte Nebentabellen anonymisieren, Sessions entziehen und Audit-Zähler schreiben | nachvollziehbare Produktaktion                                              |
| Gesellschaft nach Stichtag mit PoA-Personendaten                          | nur getrennte PoA-Signer-Redaktion anbieten                                                          | Gesellschaftsstammdaten sind nicht pauschal Personendaten der Kontaktperson |

## Ausnahmen und Grenzfälle

§ 66 Abs. 2 StBerG enthält für erhaltene Dokumente eigene Herausgabe- und
Aufbewahrungsregeln sowie Ausnahmen. Daneben können steuerliche Fristen länger
laufen. Der Produktstichtag verwendet pauschal zehn Jahre nach Ablauf des
Mandatsendejahres und kennt keine einzelne Handakte, keine erfolglose
Abholaufforderung, keinen allgemeinen Legal Hold und keine verlängerte
steuerliche Bedeutung. Ein Skelettdatensatz und unveränderbare Auditbezüge
bleiben bestehen.

## Beispiele

### Normalfall

Das Mandat einer natürlichen Person endet am 15. März 2026. TaxTronik nimmt
den Fall frühestens ab 1. Januar 2037 in die Prüfliste auf. Nach dokumentierter
Prüfung und bereits abgeschlossener GwG-Vernichtung kann eine berechtigte
Person die definierten Stammdaten anonymisieren.

### Grenzfall

Der Produktstichtag ist erreicht, aber ein Steuerverfahren ist noch offen oder
eine Handakte enthält anders zu behandelnde Dokumente. Die Queue zeigt nur
einen Kandidaten; die Anonymisierung muss bis zur fachlichen Klärung
unterbleiben.

## Umsetzung in TaxTronik

`client-retention.ts` berechnet den jahresende-basierten Stichtag und liefert
Kandidaten. `anonymize-client-data.ts` leert oder ersetzt fest definierte
personenbezogene Felder in Stammdaten, Kontakten, Vollmachten, Formularen,
Terminen, Wiedervorlagen, Übergaben und Risikoanalysen. Die Admin-Actions
sperren den Mandanten, revalidieren Fälligkeit und GwG-Vorbedingungen,
widerrufen Sitzungen und schreiben nur Zähler in den Auditnachweis.

Der NATPERS-Pfad leert außerdem USt-ID und die nur noch zur Migration vorhandene
`Client.steuernummer`. Er redigiert alle aktiven und archivierten
Steuerverbindungen (Nummer, Landeskennung, Finanzamtsname/-code und freie
Bezeichnung) und archiviert ihre leeren Beziehungsdatensätze. Diese IDs bleiben
für separat aufbewahrte ELSTER-Abfragen bestehen; deren Nummernsnapshot wird
hier nicht verändert. Steuerdatenvorschläge werden mit den übrigen
Stammdatenanträgen gelöscht. Der Steuerdaten-Service verweigert eine erneute
Befüllung bereits anonymisierter Mandanten.

Die Migration übernimmt keine Legacy-Steuernummer bereits anonymisierter
NATPERS und entfernt diese dort verbliebenen Legacy-Werte. Sie schreibt keine
historischen Audit- oder ELSTER-Nachweise um.

## Bekannte Abweichungen und Grenzen

Die Umsetzung ist teilweise. Der pauschale längste Produktansatz ist weder
eine vollständige Aktenklassifikation noch eine Legal-Hold-Engine. Nicht jede
personenbezogene Datenklasse wird in diesem Pfad verändert; Dokumente,
Rechnungen, Steuerobjekte, BWA, Zeiten und Auditdaten bleiben ihren eigenen
Regeln unterworfen. Das technische Rollen-Gate `ADMIN/PARTNER` beweist keine
Berufsträgerqualifikation und kein Vier-Augen-Prinzip.

## Fachliche Prüffragen

- Welche Unterlagen fallen im konkreten Mandat unter § 66 StBerG und welche Ausnahmen greifen?
- Welche weiteren Fristen oder Legal Holds blockieren die Anonymisierung?
- Ist die Feldliste je Datenklasse vollständig und fachlich richtig abgegrenzt?
- Welche qualifizierte Rolle und welches Kontrollprinzip müssen die Aktion freigeben?

## Technische Nachweise

Die Tests belegen Jahresende-Arithmetik, Mandantenart-Filter, Queue-Kandidaten,
Nebentabellen-Anonymisierung und den getrennten PoA-Signerpfad. Sie belegen
weder die Vollständigkeit einer konkreten Akte noch das Ende aller gesetzlichen
oder vertraglichen Aufbewahrungsgründe.
