---
id: GWG-IDENTIFICATION-EVIDENCE-001
title: Identitätsangaben erheben und mit zugeordnetem Nachweis prüfen
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
    TaxTronik erfasst natürliche Personen und Rechtsträger strukturiert, bindet
    eingescannte Nachweise an eine konkrete Person und verlangt für die
    Freigabe verfügbare, virengeprüfte Belege. Unterstützt werden jedoch nur
    ausgewählte Nachweisarten; Echtheit, amtliche Registerdaten und alternative
    elektronische Identifizierungsverfahren werden nicht selbst verifiziert.
sources:
  - kind: official_law
    citation: § 10 Abs. 1 Nr. 1 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__10.html
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: § 11 Abs. 1, 3 und 4 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__11.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 12 Abs. 1 und 2 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__12.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 8 Abs. 1 bis 3 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__8.html
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/gwg/verification.ts
  - apps/web/src/server/gwg/evidence-documents.ts
  - apps/web/src/server/gwg/identity-subject.ts
  - apps/web/src/server/gwg-onboarding/identity-persistence.ts
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/20260801004300_gwg_identity_subjects_and_document_sets/migration.sql
test_refs:
  - apps/web/src/server/gwg/__tests__/verification.test.ts
  - apps/web/src/server/gwg/__tests__/evidence-documents.test.ts
  - apps/web/src/server/gwg-onboarding/__tests__/identity-persistence.test.ts
feature_refs:
  - FEATURES.md
  - docs/compliance/gwg.md
  - docs/anwenderdoku/dokumente.md
related_rules:
  - GWG-ACTIVATION-GATE-001
  - GWG-REPRESENTATIVE-AUTHORITY-001
  - GWG-BENEFICIAL-OWNERS-001
  - GWG-SELF-ONBOARDING-001
  - GWG-RETENTION-DESTRUCTION-001
tags:
  - identifizierung
  - identitaetsnachweis
  - ausweis
  - register
---

# GWG-IDENTIFICATION-EVIDENCE-001 — Identitätsangaben erheben und mit zugeordnetem Nachweis prüfen

## Kurzfassung

Vor der Produktfreigabe müssen die für den Mandantentyp vorgesehenen
Identitätsangaben gespeichert und mit einem konkreten Nachweis verbunden sein.
Bei natürlichen Personen akzeptiert das aktuelle Gate einen gültigen
Personalausweis oder Reisepass; bei Rechtsträgern werden Rechtsform,
Registerdaten beziehungsweise Registerlosigkeit und ein Register- oder
Gründungsnachweis verlangt.

Die Software prüft Struktur, Zuordnung, Gültigkeitsdatum, Verfügbarkeit und
Virenscanstatus. Sie stellt weder die Echtheit eines Dokuments noch die
inhaltliche Richtigkeit einer amtlichen Quelle selbst fest.

## Wann gilt die Regel?

Die Regel gilt bei der Erstidentifizierung, bei Zweifeln an früher erhobenen
Angaben und bei einem neuen Prüfzyklus, der eine erneute Identitätsbestätigung
verlangt. Sie beschreibt die in TaxTronik unterstützten Nachweiswege für
Mandanten, auftretende Vertreter und Rechtsträger.

Andere gesetzlich zugelassene Verfahren wie elektronischer Identitätsnachweis,
qualifizierte elektronische Signatur oder weitere durch Rechtsverordnung
bestimmte Dokumente sind nicht Teil des automatischen Freigabegates.

## Benötigte Angaben

- konkrete zu identifizierende Person und ihre Rolle
- bei natürlicher Person Name, Geburtsort, Geburtsdatum, Staatsangehörigkeit
  und Wohnanschrift
- bei Rechtsträger Firma/Bezeichnung, Rechtsform, Sitz, Registernummer und
  Register/Registergericht, soweit vorhanden
- Dokumenttyp, Dokumentnummer, ausstellende Behörde oder Staat,
  Ausstellungsdatum und Gültigkeitsdatum
- konkrete Datei oder Dateien des Nachweises
- eindeutige Zuordnung zum Mandanten, wirtschaftlich Berechtigten oder Vertreter
- Zeitpunkt und Mitarbeiter der Identitätszuordnungsbestätigung
- Scanstatus und Verfügbarkeit der neuesten Dokumentversion

## Entscheidungslogik

| Wenn                                                                                         | Dann                                                      | Begründung                                        |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------- |
| Natürliche Person ohne eindeutig zugeordneten gültigen Ausweissatz                           | Freigabe blockieren                                       | Identität ist im Produkt nicht hinreichend belegt |
| Ausweissatz ist abgelaufen, unvollständig oder widersprüchlich                               | Freigabe blockieren                                       | Nachweisgrundlage ist nicht belastbar             |
| Datei gehört zu anderem Mandanten, ist gelöscht, in Vernichtung oder nicht `GWG_EVIDENCE`    | Nicht als Nachweis werten                                 | Mandanten- und Zweckbindung                       |
| Neueste Datei ist nicht vollständig virengeprüft und `CLEAN`                                 | Nicht als verfügbaren Nachweis werten                     | Unsicherer Upload wird nicht freigabetragend      |
| Rechtsträger mit Registereintrag ohne Register- oder Gründungsnachweis                       | Freigabe blockieren                                       | Unterstützter Rechtsträgernachweis fehlt          |
| Rechtsträger ohne Registereintrag mit dokumentierter Registerlosigkeit und Gründungsnachweis | Nachweis kann in die Prüfung eingehen                     | Unterstützter Alternativfall                      |
| Mitarbeiter bestätigt Personenzuordnung und prüft den Inhalt                                 | `verifiedAt` und Zuordnungsnachweis können gesetzt werden | Menschliche Prüfung bleibt erforderlich           |

## Ausnahmen und Grenzfälle

- § 11 Abs. 3 GwG erlaubt unter Voraussetzungen, von einer erneuten
  Identifizierung abzusehen. TaxTronik kopiert bei Re-Verifikation eine
  Arbeitsgrundlage, verlangt aber für den neuen Zyklus eine neue Bestätigung.
- Ein Ausweis ist am gespeicherten Ablaufdatum noch gültig; die Prüfung arbeitet
  mit Kalendertagen.
- Vorder- und Rückseite müssen zu einem stabilen `documentSetId` gehören und
  dieselben Metadaten tragen. Mehrere unterschiedliche Dokumente dürfen nicht
  heuristisch anhand des Namens zusammengeführt werden.
- Ein identischer Name belegt keine identische Person. Rollen werden über
  Fremdschlüssel, nicht über Namensvergleich, verbunden.
- Bei ausländischen Dokumenten und nicht standardisierten Registern ist eine
  manuelle Eignungs- und Echtheitsprüfung nötig.

## Beispiele

### Normalfall

Eine natürliche Person lädt Vorder- und Rückseite ihres Personalausweises hoch.
Beide Dateien gehören demselben Ausweissatz, sind demselben Mandanten
zugeordnet, vollständig gescannt und am Prüftag gültig. Ein Mitarbeiter
bestätigt die Zuordnung; der Nachweis kann das Freigabegate passieren.

### Grenzfall

Ein Reisepass wurde als saubere Datei gespeichert, ist aber nur anhand eines
gleichlautenden Namens einem Vertreter zugeordnet. Ohne bestätigten
Vertreter-Fremdschlüssel wird er nicht als Identitätsnachweis akzeptiert.

## Umsetzung in TaxTronik

`verification.ts` bildet das serverseitige Freigabegate. Personalausweis- und
Reisepassdateien werden nach `documentSetId` gruppiert, auf konsistente
Metadaten, genau eine Rollenreferenz, Bestätigung, Gültigkeit und einen sauberen
Dateinachweis geprüft. Die Datenbank ergänzt Eindeutigkeits- und
Integritätsregeln.

Für Rechtsträger verlangt das Gate gespeicherte Rechtsträgerdaten und je nach
Registerstatus einen Registerauszug oder ein beweiskräftiges
Gründungsdokument. Die eigentliche fachliche Sichtprüfung und Bestätigung
erfolgt durch Mitarbeiter beziehungsweise den entscheidenden Berufsträger.

## Bekannte Abweichungen und Grenzen

- Elektronischer Identitätsnachweis, qualifizierte elektronische Signatur,
  notifizierte eID-Systeme und weitere zulässige Dokumentwege werden nicht als
  strukturierter Verifikationsweg unterstützt.
- TaxTronik führt keine Ausweis-Echtheitsprüfung und keinen automatischen
  Abgleich mit amtlichen Registern durch.
- `CLEAN` bestätigt ausschließlich den technischen Virenscan, nicht die
  Identität oder Dokumentechtheit.
- Die Oberfläche erfasst nicht für jede zulässige Dokumentart alle besonderen
  Aufzeichnungspflichten aus § 8 Abs. 2 GwG.
- Eine Kopie kann gespeichert werden; ob der konkrete Nachweis im Einzelfall
  geeignet und ausreichend ist, bleibt eine manuelle Fachentscheidung.

Der Implementierungsstatus ist deshalb **teilweise**.

## Fachliche Prüffragen

- Genügen die unterstützten Dokumentarten für den tatsächlichen Mandantenkreis?
- Welche alternativen Identifizierungsverfahren sollen ergänzt werden?
- Wer darf die Identitätszuordnung bestätigen und welche Vier-Augen-Kontrolle
  ist erforderlich?
- Müssen ausländische Dokumente oder Registerquellen mit zusätzlichen
  Prüfschritten gekennzeichnet werden?
- Ist das erneute Bestätigen eines übernommenen Nachweises im jeweiligen Risiko
  ausreichend?

## Technische Nachweise

Die Verifikations- und Evidence-Helfer belegen das fail-closed Gate für
Personenzuordnung, Dateiverfügbarkeit und Dokumentgruppen. Die Tests prüfen
fremde, gelöschte, falsch klassifizierte, noch nicht sauber gescannte,
abgelaufene und widersprüchliche Nachweise sowie stabile Vorder-/Rückseiten-
Gruppen. Nicht nachgewiesen werden Echtheit oder fachliche Eignung des
Originaldokuments.
