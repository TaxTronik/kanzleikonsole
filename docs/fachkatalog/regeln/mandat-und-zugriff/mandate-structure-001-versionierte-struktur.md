---
id: MANDATE-STRUCTURE-001
title: Explizite Mandanten- und Beteiligungsstrukturen getrennt von GwG-Entscheidungen versionieren
domain: mandat-und-zugriff
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
  - apps/web/src/server/mandate-expansion/service.ts
  - apps/web/src/server/mandate-expansion/gwg-structure.ts
  - apps/web/src/server/mandate-expansion/gwg-structure-panel.tsx
  - apps/web/src/server/mandate-expansion/artifacts.ts
  - apps/web/src/server/mandate-expansion/pdf.ts
  - apps/web/src/server/documents/pdf-fonts.ts
  - packages/db/prisma/migrations/20260831120000_mandate_expansion/migration.sql
  - packages/db/prisma/migrations/20260831180000_mandate_artifacts/migration.sql
  - packages/db/prisma/migrations/20260831200000_mandate_history_integrity/migration.sql
  - packages/db/prisma/migrations/20260831260000_gwg_structure_binding/migration.sql
  - packages/db/prisma/migrations/20260831260100_structure_version_seal/migration.sql
test_refs:
  - apps/web/src/server/mandate-expansion/__tests__/service.test.ts
  - apps/web/src/server/mandate-expansion/__tests__/artifacts.test.ts
  - apps/web/src/server/mandate-expansion/__tests__/pdf.test.ts
  - apps/web/src/server/documents/__tests__/pdf-fonts.test.ts
  - packages/db/src/__tests__/mandate-assistance-expansion.test.ts
  - apps/web/src/server/mandate-expansion/__tests__/service-db.test.ts
feature_refs:
  - docs/development/module/mandate-expansion.md
related_rules:
  - GWG-BENEFICIAL-OWNERS-001
  - GWG-PERSON-LINKS-001
  - ACCESS-CLIENT-MODE-001
tags:
  - mandatsorganisation
  - arbeitsstand
  - menschliche-pruefung
---

# MANDATE-STRUCTURE-001 — Explizite Mandanten- und Beteiligungsstrukturen getrennt von GwG-Entscheidungen versionieren

## Kurzfassung

Eine interne Arbeitsstruktur verbindet ausdrücklich gewählte Mandanten sowie manuell erfasste Personen und externe Organisationen. Kanten beschreiben direkte Kapitalanteile, Stimmrechte oder sonstige Kontrolle. Das Speichern erzeugt eine neue Version; frühere Versionen werden nicht ersetzt. Eine Struktur ist weder Identitätsprüfung noch automatische Feststellung wirtschaftlich Berechtigter oder steuerlicher Organschaft.

## Wann gilt die Regel?

Die Regel gilt für das separat aktivierbare Modul `mandateStructure`, seine Tabellen-/Grafikbearbeitung und PDF-Ausgabe. GwG-Prüfsnapshots und -Freigaben werden nicht verändert. Es gibt keine automatische Synchronisation mit Personenankern oder anderen Mandantenakten.

## Benötigte Angaben

Ausgangsmandant, ausdrückliche Mandantenreferenzen, manuelle Namen externer Knoten, direkte Beziehungsart, optionaler Prozentwert, Erläuterung und Ausgangsrevision.

## Entscheidungslogik

- Der Mitarbeiter benötigt Zugriff auf den Ausgangsmandanten und alle tatsächlich referenzierten Mandanten. Fehlt ein Zugriff, wird die vollständige Struktur nicht ausgegeben oder verändert; auch PDF und Tabellen verbergen keine Namen nur optisch.
- Mandantenknoten erhalten den tatsächlichen Namen aus der zugänglichen Akte; Gleichnamigkeit erzeugt keine Personenidentität.
- Fremde Kantenenden, Selbstkanten, doppelte gleichartige Kanten, Prozentwerte außerhalb 0 bis 100 und doppelte Mandantenreferenzen werden zurückgewiesen.
- Eine veraltete Ausgangsrevision blockiert das Speichern. Eine neue Version enthält eigene Knoten und Kanten; der Hash bindet deren Inhalt und Layout.
- Knoten und Kanten dürfen nur atomar mit ihrer neuen Version entstehen. Spätere Ergänzungen in alte Versionen, Änderungen und Löschungen werden zurückgewiesen; jede Ausgabe und GwG-Übernahme prüft den gespeicherten Quellenhash erneut.
- PDF enthält Grafik, vollständige Tabelle, Version und Hash. Sichtbar gekürzte Grafiklabels tragen dieselbe Knotennummer wie die vollständige Tabelle. Eingebettete Unicode-Schriften unterstützen internationale Namen; nicht unterstützte Zeichen sperren die Ausgabe ausdrücklich. Es berechnet keine mittelbaren Quoten und erteilt keine fachliche Freigabe.
- Die ausdrückliche Archivierungsaktion bindet Strukturversion, Quellenhash, Generatorversion und Ausgabedatei über das Uploadjournal. Download liest die vorhandene geprüfte Dateifassung. Auch generische Dokumentwege verlangen weiterhin Zugriff auf alle referenzierten Mandanten; die Ausgabe bleibt intern.
- Eine konkrete unveränderliche Version kann mit eigenem Vermerk und Bestätigung als Arbeitsgrundlage an die neueste offene GwG-Prüfung gebunden werden. Eine laufende Einreichung wird über den vorhandenen Mutationsclaim auf DRAFT zurückgesetzt. Frühere Bindungen bleiben als Verlauf bestehen; abgeschlossene Prüfungen werden nicht verändert. Personen, Eigentumsquoten und fachliche Entscheidungen werden nicht automatisch in GwG-Rollen übernommen.
- Die GwG-Seite zeigt die vollständige gebundene Tabelle und Übernahmehistorie nur bei Zugriff auf alle verbundenen Mandanten. Der bestehende kontrollierte GwG-Vernichtungsübergang löst diese Verknüpfung, ihren Hash und ihren Vermerk; die separat geführte allgemeine Mandatsstruktur wird dadurch nicht als GwG-Aufzeichnung gelöscht.

## Ausnahmen und Grenzfälle

Mehrere Beziehungstypen zwischen denselben Knoten sind erlaubt. Wechselseitige Kapitalbeteiligungen werden dokumentiert und nicht automatisch rechtlich ausgewertet. Personen und Organisationen ohne Mandantenreferenz sind manuelle Angaben innerhalb dieser Akte.

## Beispiele

### Normalfall

Die berechtigte Kanzleiperson prüft den zugänglichen Arbeitsstand und protokolliert die ausdrücklich gewählte fachliche Handlung. Der aktuelle Stand und seine Nachweise bleiben getrennt erkennbar.

### Grenzfall

Der Arbeitsstand hat sich zwischen Anzeige und Bestätigung geändert oder ein erforderlicher Zugriff entfällt. Die Aktion bricht ab; die Person lädt neu und prüft erneut. Es wird keine Freigabe unterstellt.

## Umsetzung in TaxTronik

Version, Knoten und Kanten haben echte Fremdschlüssel, Tenant-RLS, Unveränderlichkeitsschutz und ergänzende Scope-Trigger. Die Grafikkoordinaten sind auch über Tabellenfelder bedienbar. Maximal 30 Knoten und 90 Kanten pro Version begrenzen den interaktiven Umfang. MandateArtifact bindet abgelegte PDF-Fassung und Datenstand; eine verlorene Speicherantwort wird im selben Intent fortgesetzt.

## Bekannte Abweichungen und Grenzen

Es gibt keinen Registerabgleich, keine Summen-/Kontroll-/Schwelleninterpretation, keine automatische Organschaft und keinen GwG-Dossierexport. Die Grafik kann bei frei gewählter überlappender Positionierung unübersichtlich sein; die vollständige Tabelle bleibt maßgeblich. Aufbewahrung und Bereinigung der zusätzlichen Arbeitssnapshots benötigen eine eigenständige fachliche Einordnung; vorhandene Anonymisierung wird nicht als automatische Löschung dieser Versionshistorie zugesagt.

## Fachliche Prüffragen

Welche Quelle belegt jede Beziehung? Welcher Stand ist fachlich freigegeben und wann ist er erneut zu prüfen? Welche Aufbewahrung gilt für die Arbeitssnapshots?

## Technische Nachweise

Tests prüfen Strukturgrenzen, Hashstabilität, veraltete Revisionen, fehlenden Zugriff auf einen verbundenen Mandanten und mehrseitige PDF-Ausgabe. Sie beweisen keine materielle Richtigkeit einer Beteiligung.
