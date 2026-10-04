---
id: AUDIT-RFC3161-ANCHOR-001
title: Audit-Spitzen mit geprüften RFC-3161-Zeitankern koppeln
domain: audit-und-assurance
rule_type: technical_standard
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Compliance und Verfahrensdokumentation
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: Externe RFC-3161-Antworten werden kryptografisch und gegen konfigurierte Vertrauensanker geprüft; lokale Stempel bleiben als nicht externe Evidenz erkennbar.
sources:
  - kind: technical_standard
    citation: IETF RFC 3161, Internet X.509 Public Key Infrastructure Time-Stamp Protocol
    url: https://www.rfc-editor.org/rfc/rfc3161.html
    checked_at: '2026-08-24'
    primary: true
  - kind: technical_standard
    citation: IETF RFC 5816, ESSCertIDv2 Update for RFC 3161
    url: https://www.rfc-editor.org/rfc/rfc5816.html
    checked_at: '2026-08-24'
    primary: false
  - kind: product_documentation
    citation: Technische Modulbeschreibung Audit-Protokollierung, externe Anchor-Kette und Tagesversiegelung
    path: docs/development/module/audit-protokollierung.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - packages/http-utils/src/index.ts
  - packages/evidence/src/ports/rfc3161-http.ts
  - packages/evidence/src/service.ts
  - packages/evidence/src/anchor-schedule.ts
  - packages/evidence/src/anchor-lease.ts
  - packages/db/prisma/migrations/20261004140100_audit_anchor_lease/migration.sql
  - packages/evidence/src/index.ts
  - packages/evidence/src/ports/rfc3161-verify.ts
  - apps/worker/src/jobs/audit-anchor.ts
  - apps/worker/src/jobs/evidence-seal.ts
  - apps/web/src/app/staff/(protected)/admin/audit/rolling-anchor-card.tsx
  - .forgejo/workflows/ci.yml
test_refs:
  - packages/http-utils/src/__tests__/response-stream.test.ts
  - packages/evidence/src/ports/__tests__/rfc3161-http-policy.test.ts
  - packages/evidence/src/__tests__/rfc3161-verify.test.ts
  - packages/evidence/src/__tests__/service-verifychain.test.ts
  - packages/evidence/src/__tests__/service-seal-trust.test.ts
  - packages/evidence/src/__tests__/service-anchor.test.ts
  - packages/evidence/src/__tests__/anchor-schedule-db.test.ts
  - packages/evidence/src/__tests__/evidence-db-ci.test.ts
  - packages/evidence/src/__tests__/verify-checkpoint-db.test.ts
  - apps/worker/src/jobs/__tests__/evidence-seal.test.ts
  - apps/web/src/app/staff/(protected)/admin/audit/__tests__/rolling-anchor-card.test.tsx
feature_refs:
  - docs/development/module/audit-protokollierung.md
  - docs/adr/0004-evidence-chain-mit-rfc3161.md
related_rules:
  - AUDIT-HASH-CHAIN-001
  - AUDIT-VERIFY-ALERT-001
  - AUDIT-ARCHIVE-001
tags:
  - audit
  - rfc3161
  - tsa
  - zeitanker
---

# AUDIT-RFC3161-ANCHOR-001 — Audit-Spitzen mit geprüften RFC-3161-Zeitankern koppeln

## Kurzfassung

TaxTronik kann Spitzen der lokalen Audit-Kette und Tagesabschlüsse mit
RFC-3161-Antworten verankern. Eine Antwort gilt erst nach Prüfung von
Message-Imprint, CMS-Signatur, Zertifikatskette, Timestamping-EKU,
Zertifikatsbindung und Erzeugungszeit als vertrauenswürdiger externer Anker.
Rolling Anchors entstehen je Kanzlei-Tenant höchstens einmal je Minute, bei
offenen Rechnungs- und GwG-Ereignissen sofort. Lokale Entwicklungsstempel
werden nicht als externe Evidenz ausgegeben.

## Wann gilt die Regel?

Die Regel gilt für Rolling Anchors und Tagesversiegelungen, wenn eine TSA oder
der transparente lokale Entwicklungsadapter konfiguriert ist. Im
Produktionsmodus kann die Policy externe TSA-Evidenz verlangen. Das lokale
Audit-Schreiben bleibt bei TSA-Ausfall verfügbar; der ausstehende externe
Nachweis wird getrennt sichtbar.

## Benötigte Angaben

- zu verankernder SHA-256-Message-Imprint
- DER-kodierte RFC-3161-Antwort
- erwarteter Hashalgorithmus und erwarteter Imprint
- konfigurierte TSA-Vertrauensanker
- Kennzeichnung, ob der Adapter externe oder lokale Evidenz liefert
- bei Rolling Anchors der gebundene Audit-ID-Bereich und vorherige Ankerhash
- für den Rolling-Anchor-Takt: Speicherzeitpunkt des letzten Ankers des
  Kanzlei-Tenants, Aktionskennungen der noch nicht verankerten Einträge,
  Mindestabstand (60 Sekunden) und ein gegebenenfalls aktiver TSA-Backoff

## Entscheidungslogik

| Prüfung                                                                                                                                      | Ergebnis                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| TSA-Status ist nicht erfolgreich                                                                                                             | Antwort ablehnen                                                                          |
| Message-Imprint oder Algorithmus weicht ab                                                                                                   | Antwort ablehnen                                                                          |
| CMS-Signatur oder Signer-Zertifikatsbindung scheitert                                                                                        | Antwort ablehnen                                                                          |
| Vertrauenskette, Gültigkeitszeit oder exklusive Timestamping-EKU scheitert                                                                   | nicht als vertrauenswürdigen externen Anker werten                                        |
| lokaler Adapter bei verlangter externer TSA                                                                                                  | lokalen Nachweis erhalten, Policy-Verstoß melden                                          |
| TSA vorübergehend nicht erreichbar                                                                                                           | Fachschreiben nicht blockieren; Rückstand bzw. Fehlerzustand persistieren                 |
| parallele Rolling-Anchor-Versuche                                                                                                            | nur einen Nachfolger der gespeicherten Ankerspitze zulassen                               |
| offener Rechnungs- oder GwG-Eintrag (`invoice.*`, `gwg.*`, `stbvv.invoice.*`, `client.update.gwg_relevant`, `client.deactivate.gwg_expired`) | Kanzlei-Tenant ohne Mindestabstand sofort und vorrangig verankern                         |
| Kanzlei-Tenant hat noch keinen Rolling Anchor                                                                                                | ohne Mindestabstand verankern                                                             |
| letzter Anker jünger als 60 Sekunden, keine Rechnungs- oder GwG-Aktion offen                                                                 | in diesem Takt nicht verankern; der nächste fällige Anker bindet die offenen Einträge mit |
| TSA-Backoff des Kanzlei-Tenants ist aktiv                                                                                                    | bis zum Ablauf der Wartezeit nicht verankern                                              |
| anderer Lauf hält den gültigen Anker-Lease des Kanzlei-Tenants                                                                               | ohne TSA-Anfrage und ohne Änderung des Ankerstatus abbrechen                              |
| Lease unmittelbar vor der TSA-Anfrage nicht mehr gültig                                                                                      | keine TSA-Anfrage, kein Insert                                                            |
| Lease nach der TSA-Antwort abgelaufen oder übernommen                                                                                        | Token verwerfen, kein Insert                                                              |
| TSA-Anfrage oder Prüfung der Antwort scheitert                                                                                               | Fehler persistieren und TSA-Backoff verlängern                                            |
| Datenbank- oder Pool-Fehler beim Verankern                                                                                                   | kein TSA-Backoff, Ankerstatus unverändert; nächster Takt versucht erneut                  |

## Ausnahmen und Grenzfälle

Die Vertrauenskette wird für die im Token enthaltene `genTime` geprüft. Eine
gültige TSA-Zeit bescheinigt die Existenz des abgedeckten Imprints spätestens
zu diesem Zeitpunkt, nicht den exakten Zeitpunkt jedes gebundenen
Fachereignisses. Ein kryptografisch lesbarer Token ohne vertrauenswürdige Kette
ist kein erfolgreicher externer Vertrauensnachweis.

Rechnungs- und GwG-Ereignisse erkennt der Takt ausschließlich an der
Aktionskennung: an den Präfixen `invoice.`, `gwg.` und `stbvv.invoice.` sowie
an den Aktionen, die auch die Audit-Ansicht als GwG einordnet
(`client.update.gwg_relevant`, `client.deactivate.gwg_expired`). Die Liste ist
einmal in `anchor-schedule.ts` definiert; ein Audit-Eintrag trägt kein eigenes
Dringlichkeitsmerkmal. Ein sofort verankerter Tenant bindet dabei auch alle
übrigen offenen Einträge bis zur aktuellen Spitze. Der Mindestabstand bemisst
sich am Speicherzeitpunkt des letzten Rolling Anchors, nicht an der TSA-Zeit.

## Beispiele

### Normalfall

Der Worker sendet den Payload der aktuellen Audit-Spitze an eine externe TSA.
Die Antwort bindet den erwarteten SHA-256-Imprint, besitzt eine gültige
Timestamping-Zertifikatskette und wird als nächster gekoppelter Anker
gespeichert.

### Grenzfall

Die TSA ist nicht erreichbar. Neue Fachereignisse werden weiter in die lokale
Hash-Kette geschrieben; der Worker hält den ausstehenden Präfix fest und
versucht die externe Verankerung später erneut.

## Umsetzung in TaxTronik

`rfc3161-verify.ts` zerlegt und prüft die Antwort. `service.ts` bindet lokale
Spitze, ID-Bereich und vorherigen Token in Rolling Anchors beziehungsweise den
Tagesspitzen-Hash in Tagesversiegelungen. Die Worker führen Netzwerkaufrufe
außerhalb der Fachtransaktion aus und persistieren Erfolg oder Rückstand
explizit.

Der Rolling-Anchor-Worker tickt weiterhin alle zwei Sekunden.
`anchor-schedule.ts` wählt je Takt nur Kanzlei-Tenants mit offenen Einträgen
ohne aktiven TSA-Backoff, die einen offenen Rechnungs- oder GwG-Eintrag
haben, noch keinen Anker besitzen oder deren letzter Anker mindestens den
Mindestabstand alt ist; Rechnung und GwG kommen zuerst, danach der älteste
offene Eintrag. Der Mindestabstand ist als
`AUDIT_ANCHOR_MIN_TENANT_INTERVAL_MS` (60 Sekunden) in der gemeinsamen
Job-Konfiguration hinterlegt. `anchorLatestWithLease` (`anchor-lease.ts`)
beansprucht vor dem TSA-Aufruf je Kanzlei-Tenant einen sofort committeten Lease
mit 30 Sekunden Laufzeit in der owner-only Tabelle `audit_anchor_lease`,
bestätigt und verlängert ihn unmittelbar vor der Anfrage und erneut nach der
Antwort und gibt ihn nach bedingtem Insert und Statusspeicherung frei.
Während der HTTP-Anfrage hält der Worker weder Transaktion noch
Pool-Verbindung. Ein abgelaufener Lease darf übernommen werden; da die
TSA-Anfrage nach höchstens zehn Sekunden endet, ist eine bestätigte Anfrage
dann in der Regel abgeschlossen. Trifft eine Antwort doch erst nach Ablauf
des Leases ein, verwirft der frühere Halter das Token; sein Insert ist
zusätzlich an den noch gültigen Lease gebunden. Kein Token wird daher unter
einem abgelaufenen Lease gespeichert, und zwei Läufe fragen bei einer
TSA-Anfrage innerhalb ihres Timeouts nie gleichzeitig ein Token für dieselbe
Kettenspitze an. Ein Lauf ohne Lease
bricht ohne TSA-Anfrage ab und lässt den gespeicherten Ankerstatus unverändert.
Nur TSA- und Tokenfehler starten den Backoff; Datenbank- und Pool-Fehler
ändern den Status nicht. Der Lease ist vom Schreib-Lock der Audit-Kette
getrennt; Fachschreiben warten nicht auf die TSA. Das bedingte Insert
verhindert weiterhin Ankerzweige.

Die Kettenprüfung lädt die gespeicherten TSA-Antworten der Rolling Anchors
blockweise statt vollständig auf einmal. Der tägliche Prüflauf
(`AUDIT-VERIFY-ALERT-001`) verifiziert kryptografisch nur die seit dem
Prüf-Checkpoint neu gespeicherten Anker einschließlich ihrer Verkettung mit dem
zuletzt geprüften Anker; Anzahl und letzter geprüfter Anker werden in jedem
Lauf abgeglichen. Alle Anker werden erst in der periodischen Vollprüfung erneut
kryptografisch geprüft.

Die Audit-Oberfläche stellt den gespeicherten externen Rolling-Anker neben
der lokalen Kettenspitze dar. Ohne Anker bleibt die Anzeige neutral. Ein
grünes Symbol setzt einen vorhandenen, als vertrauensverankert gespeicherten
Anker ohne offenen Restbestand oder gemeldete Verzögerung voraus; fehlendes
Vertrauen und lokaler Zeitstempelmodus bleiben sichtbar. Diese Darstellung
führt keine neue kryptografische Prüfung aus und ersetzt nicht den getrennten
persistierten Integritätsprüfstatus. Die Kartenregression prüft Leerstand,
fehlendes Vertrauen, offene lokale Ereignisse, TSA-Verzögerung und lokalen
Zeitstempelmodus einschließlich großer Audit-IDs.

Der gemeinsame HTTP-Transport liest Antworten nach Bedarf des Consumers,
statt sie unabhängig von dessen Größenprüfung vorab vollständig zu puffern.
Größenbedingter Abbruch und Timeout erreichen den Reader des ursprünglichen
Antwortstroms und schließen die Verbindung. Das bestehende TSA-Byte-Limit und
die kryptografischen Vertrauensentscheidungen bleiben unverändert.

Auch frühe Ablehnungen bei HTTP-Fehlerstatus oder bereits angekündigter
Übergröße brechen den Request ab, bevor der Timeout entfernt wird. So bleiben
weder ungelesener Antwortstrom noch gepinnter HTTP-Agent nach dem Fehler offen.

## Bekannte Abweichungen und Grenzen

Die Implementierung ist nur teilweise als externer Nachweis wirksam: Ohne
erreichbare TSA und korrekt gepflegte Trust Roots bleibt lediglich lokale
Evidenz. Der Produktionsmodus meldet diesen Zustand als Policy-Verstoß, ersetzt
ihn aber nicht durch einen behaupteten externen Nachweis. Eine laufende
OCSP-/CRL-Abfrage und eine umfassende Langzeitvalidierung nach Ende der
Zertifikatsgültigkeit sind in diesem Prüfpfad nicht implementiert. Eine
Änderung an einem bereits geprüften Anker, die weder die Zahl der Anker noch den
zuletzt geprüften Anker berührt, meldet erst die nächste Vollprüfung
(`AUDIT-VERIFY-ALERT-001`). Dasselbe gilt, wenn sich das Prüfergebnis bereits
geprüfter Anker oder Tagesversiegelungen ohne Datenänderung ändert, etwa nach
einem Wechsel des TSA-Trust-Stores; bis dahin bleiben die früheren Befunde
maßgeblich.

Einträge außer Rechnungs- und GwG-Aktionen werden erst bis zu rund 60 Sekunden
zuzüglich Takt nach dem vorherigen Anker desselben Kanzlei-Tenants extern
verankert; bis dahin besteht für sie nur lokale Evidenz. Der Anker-Lease wirkt
nur zwischen Läufen, die ihn verwenden. Ein Worker ohne Lease, etwa während
eines Rolling Deployments, kann eine zusätzliche TSA-Anfrage stellen; einen
Ankerzweig verhindert dann weiterhin das bedingte Insert. Bricht ein Lauf ab,
ohne den Lease freizugeben, verankert dieser Kanzlei-Tenant, auch für
Rechnungs- und GwG-Einträge, erst nach Ablauf der 30 Sekunden wieder.

## Fachliche Prüffragen

- Welche TSA und welche Trust Roots sind für die konkrete Installation
  freigegeben?
- Welche maximale Zeitspanne ohne externen Anker ist organisatorisch zulässig?
- Ist der Mindestabstand von 60 Sekunden je Kanzlei-Tenant vertretbar, und
  genügt die sofortige Verankerung von Rechnungs- und GwG-Ereignissen, oder
  brauchen weitere Ereignisklassen einen Anker ohne Mindestabstand?
- Welche Sperr- und Langzeitvalidierungsnachweise müssen zusätzlich archiviert
  werden?
- Ist die Bedeutung der TSA-Zeit gegenüber dem lokalen Ereigniszeitpunkt in
  Verfahrens- und Anwenderdokumentation ausreichend abgegrenzt?

## Technische Nachweise

Die RFC-Fixture- und Negativtests prüfen Imprint, Signatur, Zertifikatskette,
EKU und Trust-Policy. Service- und Worker-Tests prüfen die Bindung an die
rekonstruierte Kettenspitze, lokales gegenüber externem Vertrauen, Backfill und
Fehlerbehandlung. Die PostgreSQL-Regression der Checkpoint-Prüfung belegt das
blockweise Laden der Ankerantworten, die Prüfung nachträglicher Anker gegen die
einzeln nachgerechnete Spitze und die Erkennung eines unterhalb des
Checkpoints gelöschten Ankers.

Die PostgreSQL-Regression des Anker-Takts belegt Auswahl und Reihenfolge,
die Sofortverankerung von Rechnungs- und GwG-Einträgen, die Intervallgrenze bei
59 und 61 Sekunden, den Backoff sowie den Lease: Während der TSA-Anfrage ist
die einzige Pool-Verbindung eines Clients mit Poolgröße 1 frei, ein paralleler
Lauf fragt die TSA nicht an, die Statusspeicherung läuft noch unter dem Lease,
danach ist er freigegeben; nur ein abgelaufener Lease wird übernommen, und ein
Datenbankfehler zählt nicht als TSA-Fehler. Läuft der Lease während der
TSA-Anfrage ab und übernimmt ein zweiter Lauf, verwirft der erste sein Token,
und es bleibt bei einem Anker. Service-Tests belegen Bestätigung vor der
Anfrage und nach der Antwort, das Verwerfen des Tokens nach Ablauf des
Leases, die Lease-Dauer von 30 Sekunden, die Bindung des Inserts an den
Lease, die Fehlerklassen und
die Liste der sofort zu verankernden Aktionen; ein Workflow-Test sichert den
CI-Schritt der PostgreSQL-Regressionen.

Transportregressionen verwenden echte Web-Streams bei simulierter HTTP-Grenze
und prüfen begrenztes Vorab-Lesen, Abbruchweitergabe, Timeout, vollständige
Antwortbytes sowie einmaliges Schließen. Ein zusätzlicher lokaler Socket-Test
bestätigt das Schließen laufender HTTP-Antworten bei Cancel und Abort.
Die Adaptertests prüfen zusätzlich sofortigen Abbruch bei HTTP 503 und bei
einer vor dem ersten Read erkannten Übergröße.
