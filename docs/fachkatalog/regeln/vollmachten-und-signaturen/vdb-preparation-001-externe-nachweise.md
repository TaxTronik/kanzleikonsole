---
id: VDB-PREPARATION-001
title: VDB-Vorbereitung und extern belegte Meldeschritte unabhängig vom Signaturstatus dokumentieren
domain: vollmachten-und-signaturen
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Kanzleiorganisation
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Die abgegrenzte Produktfunktion ist implementiert; eine fachliche Freigabe
    und weitergehende materielle oder externe Vollständigkeitszusagen fehlen.
sources:
  - kind: product_documentation
    citation: Modulbeschreibung Mandatsorganisation und Erweiterungsgrenzen
    path: docs/development/module/mandate-expansion.md
    checked_at: '2026-08-31'
    primary: true
code_refs:
  - apps/web/src/server/mandate-expansion/vdb.ts
  - packages/db/prisma/migrations/20260831120000_mandate_expansion/migration.sql
  - packages/db/prisma/migrations/20260831200000_mandate_history_integrity/migration.sql
test_refs:
  - apps/web/src/server/mandate-expansion/__tests__/service.test.ts
feature_refs:
  - docs/development/module/mandate-expansion.md
related_rules:
  - POA-LIFECYCLE-001
  - POA-SIGNING-CONFIRMATION-001
  - POA-SIGNING-SNAPSHOT-001
tags:
  - mandatsorganisation
  - arbeitsstand
  - menschliche-pruefung
---

# VDB-PREPARATION-001 — VDB-Vorbereitung und extern belegte Meldeschritte unabhängig vom Signaturstatus dokumentieren

## Kurzfassung

Das Modul dokumentiert eine interne Vorbereitung und nachgewiesene externe Meldeschritte. Es erzeugt keine als VDB-kompatibel ausgegebenen Importdateien und besitzt keine aktive Übermittlungsschnittstelle. Ein manuell dokumentierter Status wird nicht als automatisch verifizierte Behördenbestätigung dargestellt.

## Wann gilt die Regel?

Die Regel gilt für das optionale Modul `vdbPreparation` und bestehende PowerOfAttorney-Datensätze. Technischer Signaturstatus, Rechtswirksamkeit, Datenabrufberechtigung und externer Meldestatus bleiben getrennte Aussagen.

## Benötigte Angaben

Vollmacht, aktueller Mitarbeiter und Mandantenzugriff, Ausgangsrevision, nächster erlaubter Status, tatsächliches Nachweisdatum, Erläuterung sowie für externe Statusangaben eine saubere Dokumentfassung desselben Mandanten. Externe Referenzen bleiben manuelle Angaben.

## Entscheidungslogik

- Ein neuer Verlauf beginnt mit PREPARED. Nur danach kann REPORTED und anschließend CONFIRMED, REJECTED oder WITHDRAWN dokumentiert werden.
- Nach Zurückweisung oder Rücknahme erfordert eine weitere Meldung eine neue Vorbereitung.
- Vorbereitung und Meldedokumentation verlangen einen technischen SIGNED-Status; diese Bedingung beweist nicht, dass die konkrete Form fachlich ausreicht.
- Externe Statusangaben benötigen einen Dokumentnachweis. Fremde, gelöschte, ungeprüfte, GwG-, Personal- oder private Nachweise werden abgewiesen.
- Veraltete Revisionen werden zurückgewiesen. Jeder akzeptierte Schritt erzeugt einen neuen Datensatz; frühere Angaben werden nicht überschrieben.
- Ohne implementierte und nachgewiesene offizielle Importspezifikation bleibt der Datei-/Schnittstellenexport gesperrt.

## Ausnahmen und Grenzfälle

Ein Dokument kann technisch sauber und dennoch fachlich ungeeignet sein. Herkunft und Aussage muss die Kanzlei prüfen. Rücknahme im lokalen Verlauf versendet keinen Widerruf und ändert nicht automatisch eine Eintragung außerhalb des Produkts.

## Beispiele

### Normalfall

Die berechtigte Kanzleiperson prüft den zugänglichen Arbeitsstand und protokolliert die ausdrücklich gewählte fachliche Handlung. Der aktuelle Stand und seine Nachweise bleiben getrennt erkennbar.

### Grenzfall

Der Arbeitsstand hat sich zwischen Anzeige und Bestätigung geändert oder ein erforderlicher Zugriff entfällt. Die Aktion bricht ab; die Person lädt neu und prüft erneut. Es wird keine Freigabe unterstellt.

## Umsetzung in TaxTronik

VdbRecord referenziert Mandant, Vollmacht, optional konkrete Dokumentversion und Mitarbeiter über echte Fremdschlüssel. Scope-Trigger und Tenant-RLS schützen die Zuordnung; revisionsweise Einträge und Audit halten den Verlauf fest. Der Exportbutton ist ohne aktivierte reale Formatspezifikation gesperrt.

## Bekannte Abweichungen und Grenzen

Kein offizielles Importformat, keine VDB-/ELSTER-Übermittlung, keine automatische Statusabfrage oder Identitäts-/Wirksamkeitsprüfung ist implementiert. Das Modul ist deshalb eine beleggestützte Arbeitsliste, keine fertige VDB-Schnittstelle. Historische Referenzdaten besitzen noch keine eigene automatisch ausgeführte Löschregel.

## Fachliche Prüffragen

Welche konkrete Meldestrecke nutzt die Kanzlei, und welche autorisierte Spezifikation steht zur Verfügung? Welche Nachweise belegen Einreichung, Rückmeldung und Rücknahme? Wer prüft Umfang, Vertretungsmacht und Form?

## Technische Nachweise

Tests prüfen unzulässige Statussprünge, erneute Vorbereitung nach Zurückweisung, veraltete Revisionen und den mandatsgebundenen Dokumentnachweis. Sie belegen keine externe Meldung oder Behördenentscheidung.
