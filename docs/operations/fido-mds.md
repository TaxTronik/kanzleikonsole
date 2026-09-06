# FIDO-MDS und Hardware-Attestation betreiben

Dieses Runbook gilt nur für den optionalen Staff-Modus **„Nur physische
FIDO2-Sicherheitsschlüssel“**. Der Passwort-/TOTP-Standardmodus und der
Magic-Link-Zugang des Mandantenportals bleiben davon unabhängig.

## 1. Verbindliche Konfiguration

`WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST` enthält eine kommaseparierte Liste
freigegebener AAGUIDs. Der Config-Parser trimmt die Werte, normalisiert sie auf
Kleinschreibung, entfernt Duplikate und akzeptiert höchstens 128 UUIDs.
`WEBAUTHN_HARDWARE_POLICY_REVISION` ist eine positive, monoton zu erhöhende
Deployment-Revision für diese Vertrauenspolicy.

```env
WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa,bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
WEBAUTHN_HARDWARE_POLICY_REVISION=1
```

Die globale Variable darf leer bleiben, damit eine Installation ohne
Hardware-Feature startet. **Für die Nutzung des Hardware-Zugangs ist eine
nichtleere Liste zwingend:** Bei fehlender oder leerer Allowlist lehnen
Enrollment, Login sowie Aktivierungs- und Deaktivierungs-Assertions
fail-closed ab. Auch dieser deaktivierte Zustand wird mit Revision und
kanonischem Policy-Hash zentral in der Datenbank gebunden. Soll eine zuvor
aktive Policy durch eine leere Allowlist global deaktiviert werden, muss ihre
Revision deshalb erhöht werden. Eine AAGUID darf nicht geraten oder nur aus
einer Herstellerangabe übernommen werden; sie ist gegen die verifizierten
FIDO-Metadaten und die konkret beschaffte Schlüsselserie zu prüfen.

Alle Replicas eines stabilen Deployments müssen dieselbe Revision und denselben
aus Aktivstatus und sortierter Allowlist gebildeten Policy-Hash verwenden. Eine
Replica mit derselben Revision, aber abweichendem Hash, oder mit einer
niedrigeren Revision startet beziehungsweise arbeitet fail-closed. Eine höhere
Revision übernimmt den zentralen Policy-Anker und verdrängt ältere Replicas:
Deren laufende Hardware-Zeremonien können den Commit-Guard danach nicht mehr
passieren. Die Revision ist daher bei jeder Änderung der Allowlist oder der
gebundenen Hardware-Vertrauenspolicy zu erhöhen und zusammen mit der neuen
Konfiguration kontrolliert auszurollen.

Eine AAGUID bezeichnet eine Authentikator-Modellfamilie, keine Seriennummer und
keine eindeutige physische Instanz. Zwei registrierte Credentials – auch mit
verschiedenen Credential-IDs – sind daher **kein kryptografischer Nachweis für
zwei unterschiedliche physische Geräte**. Beide Schlüssel müssen vor dem
Opt-in getrennt getestet, gekennzeichnet und verwahrt werden.

## 2. Geprüfte Attestationsrichtlinie

Beim Enrollment fordert TaxTronik `attestation: direct` an und akzeptiert nur
eine vollständige `packed`-Attestation mit Zertifikatskette. Der FIDO Metadata
Service wird aus einem selbst verifizierten, signierten Gesamt-BLOB im Modus
`strict` initialisiert. Das Modell muss in der lokalen Allowlist stehen; sein
vollständiger MDS-Eintrag und Metadata Statement müssen unter anderem eine
Attestation Root, `basic_full`, Hardware- oder Secure-Element-Schlüsselschutz
und einen externen Authentikator ausweisen. Software-, Remote-Handle-, interne
oder Plattform-Modelle werden abgelehnt.

Noch vor einem Metadaten- oder CRL-Netzzugriff begrenzt eine lokale Vorprüfung
die UTF-8-kodierte Registrierungsantwort auf 768 KiB, das Base64url-kodierte
Attestation-Objekt auf 512 KiB sowie `x5c` auf ein bis fünf Zertifikate mit
jeweils höchstens 64 KiB DER. Die gesamte anschließende Attestationsprüfung hat
ein 30-Sekunden-Zeitlimit, dessen Abbruchsignal bis zu Zertifikats- und
CRL-Abrufen weitergereicht wird. Das Blattzertifikat muss die nichtkritische
FIDO-AAGUID-Extension `1.3.6.1.4.1.45724.1.1.4` enthalten; ihr exakt
16 Byte langer Wert muss mit der AAGUID aus den signierten Authenticator-Daten
übereinstimmen. Damit kann ein Zertifikat unter einer gemeinsam genutzten Root
nicht für eine andere Modell-AAGUID eingesetzt werden.

Die Statuspolicy ist positiv: Mindestens ein aktuell wirksamer
`FIDO_CERTIFIED*`-Status ist erforderlich; zusätzlich ist nur
`UPDATE_AVAILABLE` zulässig. `REVOKED`, `NOT_FIDO_CERTIFIED`,
`SELF_ASSERTION_SUBMITTED`, sämtliche Kompromittierungsstatus, unbekannte oder
ungültige Statuswerte sowie ein fehlender Status blockieren fail-closed. Ein
vorhandenes `sunsetDate` wird als UTC-Kalendertag strikt validiert; ab diesem
Tag trägt der Report keinen aktuellen Zertifizierungsnachweis mehr. Damit wird
nicht allein auf `MetadataService.getStatement()` vertraut, denn das Statement
selbst enthält die übergeordneten Statusberichte nicht.

Aus dem Blattzertifikat der `packed`-Attestation wird außerdem die nicht
kritische FIDO-Firmware-Extension `1.3.6.1.4.1.45724.1.1.5` als kanonische,
nichtnegative DER-Ganzzahl im uint32-Bereich gelesen. Der attestierte Wert muss
mindestens der `authenticatorVersion` des Metadata Statements und derjenigen
aktuell wirksamen Zertifizierungsberichte entsprechen, die den positiven
Nachweis tragen. Er wird unveränderlich am Credential gespeichert und bei
jeder späteren Assertion erneut gegen den aktuellen MDS-Stand geprüft.
Bestands-Credentials ohne diesen Wert werden fail-closed abgewiesen und müssen
neu registriert werden.

Zusätzlich bleiben User Verification, RP-/Origin-Bindung, `cross-platform`,
`singleDevice`, kein Backup und ein gemeldeter Transport USB, NFC, BLE oder
Smartcard erforderlich. Attachment und Transporte sind weiterhin
Clientangaben; die verifizierte Attestation ersetzt diese Zusatzfilter nicht.

Jede spätere Hardware-Assertion prüft erneut, dass die gespeicherte Attestation
vollständig markiert ist, die AAGUID noch in der aktuellen Deployment-
Allowlist steht und der aktuelle MDS-Eintrag einschließlich Status die
Hardware-Richtlinie erfüllt. Beim Aktivieren müssen mindestens zwei aktive
Credentials diese aktuelle Prüfung bestehen; nur eines davon wird in diesem
Schritt kryptografisch präsentiert. Entfernte Modelle, fehlende,
nichtzertifizierte, widerrufene beziehungsweise kompromittierte Metadaten und
Prüffehler blockieren die Assertion oder Aktivierung fail-closed.

## 3. Netz, Cache und Refresh

TaxTronik bezieht den signierten MDS-v3-Gesamt-BLOB per HTTPS von
`https://mds.fidoalliance.org/`, begrenzt Größe und Abrufzeit und prüft
Zertifikatskette sowie JWT-Signatur vor der Auswertung. Der App-Container
benötigt dafür funktionierende DNS-Auflösung, TLS-Vertrauenskette, Systemzeit
und ausgehenden TCP-Port 443. Zusätzlich müssen die in einer bereits
vertrauenswürdig aufgebauten Zertifikatskette angegebenen CA-CRL-Endpunkte über
HTTP oder HTTPS auf den Standardports 80 beziehungsweise 443 erreichbar sein;
Redirects sowie URLs mit Zugangsdaten oder abweichenden Ports werden
abgewiesen. Unterstützt wird bewusst nur genau ein unpartitionierter
Distribution Point mit genau einer vollständigen URI. Mehrere Points oder
Namen, `reasons`, `cRLIssuer` und relative Namen werden vor dem Abruf
fail-closed abgewiesen. Die Kanzlei muss MDS- und benötigte CA-Ziele in ihrer
Egress-Policy eng zulassen und deren Erreichbarkeit überwachen.

Vor der kryptografischen Kettenprüfung bindet TaxTronik den geschützten
`RS256`-JWT-Header zusätzlich an die freigegebene MDS-Signeridentität: Das
Blattzertifikat muss exakt `mds.fidoalliance.org` / `Fido Alliance, Inc.` samt
einzigem gleichlautendem DNS-SAN, Server-EKU, Signatur-Key-Usage und
`CA=false` ausweisen; der direkte Issuer ist derzeit auf
`GlobalSign GCC R46 EV TLS CA 2025` / `GlobalSign nv-sa` festgelegt. Eine
normale Erneuerung unter derselben Identität und demselben Intermediate wird
ohne Konfigurationsänderung akzeptiert. Ein Wechsel des Intermediates oder der
Signeridentität blockiert dagegen bewusst fail-closed und erfordert vorab eine
geprüfte Codeänderung mit Release.

Das Zeitlimit von 30 Sekunden umfasst die gesamte BLOB-, Signatur-,
Zertifikatsketten- und CRL-Prüfung. Die exakt gepinnte
`@simplewebauthn/server`-Version trägt einen im pnpm-Lockfile gehashten Patch:
HTTP-, Netzwerk- oder Parsefehler beim Abruf einer in der Zertifikatskette
angegebenen Certificate Revocation List werden nicht als „nicht widerrufen“
behandelt, sondern blockieren fail-closed. Zuerst muss die Kette ohne
Netzzugriff bis zu exakt einer freigegebenen Trust Anchor aufgebaut werden.
Doppelte Zertifikate, fehlende oder nichtkritische
`CA=true`-BasicConstraints, fehlendes `keyCertSign`, verletzte
`pathLenConstraint`, unbekannte kritische Extensions sowie nicht unterstützte
Name-/Policy-Constraints werden abgewiesen. Erst danach darf eine CRL geladen
werden. Sie muss zeitlich gültig und vom tatsächlichen nächsten Issuer der
Kette signiert sein; Issuername und, soweit vorhanden, AKI/SKI müssen passen
und eine vorhandene Issuer-KeyUsage muss `cRLSign` erlauben. Die Signatur wird
mit dem öffentlichen Issuer-Schlüssel und dem Signaturalgorithmus der CRL
geprüft. Zertifikat-seitige `freshestCRL`-Verweise sowie Delta-CRLs,
`issuingDistributionPoint`, `freshestCRL` und sämtliche unbekannten kritischen
Extensions in der CRL werden bis zu einer vollständigen Scope-/Delta-Auswertung
abgewiesen; eine partielle Liste darf nie als vollständige Negativauskunft
gecacht werden.

Das gemeinsame Abbruchsignal wird bis zu diesen Abrufen weitergereicht, jede
CRL ist beim Streaming auf 5 MiB begrenzt und der authentisierte
Widerrufsstatus-Cache umfasst höchstens 256 Kombinationen aus
Issuer-Fingerprint, Zertifikatsseriennummer und CRL-URL. Ein Eintrag gilt
höchstens bis zum signierten `nextUpdate` der CRL. Der MDS-Gesamt-BLOB wird
ebenfalls streamend auf 20 MiB begrenzt. Bei einem
Dependency-Upgrade muss dieses Upstream-Verhalten erneut geprüft und der Patch
bewusst angepasst oder entfernt werden; `pnpm guard:supply-chain` schützt die
Versions-/Patchbindung.

Beim Produktionsstart bindet jede App-Replica ausschließlich Revision und Hash
der lokalen Hardware-Policy an den zentralen Datenbankzustand. Dieser
Startup-Schritt führt keinen MDS- oder CRL-Netzzugriff aus und macht den
Passwort-/TOTP- sowie Portalbetrieb daher nicht von der MDS-Erreichbarkeit beim
Start abhängig. Der MDS-Snapshot wird erst bei der ersten benötigten
Hardware-Zeremonie geladen und liegt nur im App-Prozess. Er wird spätestens
nach einer Stunde oder bereits zum früheren signierten `nextUpdate` vor dem
nächsten Hardware-Vorgang verworfen und neu geladen.

Nach erfolgreicher kryptografischer Prüfung von Signatur, Zertifikatskette,
CRLs, BLOB-Seriennummer und `nextUpdate` wird die signierte Seriennummer
clusterweit monoton in der ausschließlich owner-seitig beschreibbaren Tabelle
`fido_mds_trust_state` übernommen, **bevor** die Einträge gegen die lokale
AAGUID-Allowlist und Modellpolicy gefiltert werden. Enthält ein gültiger neuer
BLOB danach kein lokal nutzbares Modell, bleibt seine höhere Seriennummer
zentral wirksam und der Hardware-Vorgang scheitert fail-closed; andere Replicas
können nicht mit einem älteren Snapshot weiter committen.

Die App-Rolle besitzt keine Tabellenrechte; sie darf nur eine eng begrenzte
SECURITY-DEFINER-Funktion aufrufen. Der Commit-Guard vergleicht exakt die für
die Prüfung verwendete BLOB-Serie, Policy-Revision und den kanonischen
Policy-Hash und hält den Anker bis zum Ende derselben WebAuthn-Mutation mit
einem Share-Lock. Sicherheitsrelevante Mutationen nehmen diesen MDS-Lock vor
den Staff-Locks (`MDS -> Staff`); diese Reihenfolge ist in allen Pfaden
beizubehalten. Registrierung, Login, Moduswechsel und Hardware-Recovery
committen dadurch nur gegen genau den MDS- und Policy-Stand ihrer
Vertrauensprüfung. Ein anderer Prozess, Neustart oder Restore kann keinen BLOB
mit kleinerer Seriennummer übernehmen, solange der DB-Anker selbst nicht auf
einen älteren Recovery Point zurückgesetzt wurde. TaxTronik prüft den
gecacheten, signierten Eintrag und den DB-Anker vor jeder Hardware-Assertion
erneut. Es gibt weiterhin keinen separaten periodischen Refresh-Job, keine
persistente Offline-Kopie des BLOBs und keine eigene MDS-Statusseite.

Schlägt Download, Signatur-/Chain-/CRL-Prüfung oder Refresh des Gesamt-BLOBs
fehl, wird die Readiness verworfen und ein späterer Versuch initialisiert
erneut. Bis dahin bleiben Hardware-Enrollment und -Assertions gesperrt. Ein
fehlender, widerrufener oder anderweitig unzulässiger Eintrag schließt dagegen
nur die betroffene Modellfamilie aus dem aktuellen Vertrauenssnapshot aus;
mindestens ein freigegebenes und positiv geprüftes Modell muss übrig bleiben.
So blockiert ein widerrufenes Modell nicht gleichzeitig die Anmeldung mit
einem anderen weiterhin zulässigen Modell. Zu überwachen sind insbesondere
Warnungen mit der Komponente `staff-webauthn` und den Meldungen
„FIDO-Metadaten-Richtlinie ist nicht bereit“, „FIDO-Schlüsselmodell aus
aktuellem Vertrauenssnapshot ausgeschlossen“ beziehungsweise
„FIDO-Hardware-Attestation wurde abgewiesen“.

Vor einem Hardware-only-Rollout und nach Netzwerk-, CA-, Proxy-, Image- oder
Allowlist-Änderungen sind Enrollment und Assertion mit allen freigegebenen
Modellfamilien zu testen. Ein MDS-Ausfall erzeugt keinen Passwort-/TOTP-
Fallback. Bei vollständiger Aussperrung gilt der dokumentierte hierarchische
Recovery-Pfad; für ADMIN-Konten die Owner-CLI. Der Web-Pfad verlangt vorab
einen Step-up des handelnden Akteurs: im Passwortmodus aktuelles Passwort plus
frischen TOTP ohne Backup-Code, im eigenen Hardware-only-Modus eine
WebAuthn-Assertion des eigenen Schlüssels. Deren Einmal-Challenge bindet
Akteur, Zielkonto und Auth-Revision. Die hierarchisch autorisierten Recovery-
Mutationen, der Credential-Widerruf, die Erhöhung der `authRevision` und das
Audit werden in einer Datenbanktransaktion abgeschlossen. Die neue Revision
ist der autoritative Cutoff für bestehende Staff-Sessions; dadurch kann ein
vor einer später abgewiesenen Transaktion ausgeführter Redis-Widerruf weder
beim Recovery noch beim regulären Hardware-Moduswechsel einen verwaisten
Logout hinterlassen.

Die Web-Benutzerverwaltung schützt außerdem den Recovery-Rollenboden: Kein
Staff-Akteur darf eine ADMIN-Rolle entziehen; eine PARTNER-Rolle darf nur ein
aktiver ADMIN desselben Tenants entziehen. Normale Passwort- und TOTP-Resets
sind an die frisch gelesene `authRevision` des Akteurs gebunden. Sie widerrufen
auch solche aktiven Hardware-Credentials des Zielkontos, die noch vor einem
späteren Hardware-only-Opt-in im Passwortmodus registriert wurden. Eine eigene
Passwortänderung widerruft entsprechend die eigenen noch aktiven Hardware-
Credentials. Damit kann ein ruhendes Credential nach einem Sicherheitsreset
nicht unbemerkt wieder als Hardware-Faktor verwendet werden.

Die ADMIN-Owner-CLI gibt das Recovery-Passwort ausschließlich als Klartext in
der explizit gewählten Credential-Datei aus, niemals auf `stdout`, `stderr`
oder in Logs. Sie legt die Datei vor dem Datenbank-Commit mit exklusiver
Neuanlage (`O_EXCL`) und No-follow-Schutz an, erzwingt auf POSIX Modus `0600`
und synchronisiert erst die Datei sowie anschließend das POSIX-Elternverzeichnis.
Existiert der Zielpfad bereits oder scheitert Schreiben beziehungsweise
Synchronisieren, entfernt die CLI nur die von diesem Versuch angelegte
Teildatei und rollt die gemeinsame Reset-/Audit-Transaktion zurück; eine zuvor
vorhandene Datei bleibt unverändert. Scheitert erst der Datenbank-Commit nach
der dauerhaft geschriebenen Datei, kann eine sichere, aber unwirksame
Credential-Datei zurückbleiben. Sie ist anhand des CLI-Fehlers zu verwerfen,
bevor der Vorgang mit einem neuen Zielpfad wiederholt wird.

## 4. Allowlist-Änderungen

- **Hinzufügen:** MDS-Statement und Beschaffungsmodell prüfen, Testschlüssel
  enrollen und Assertion ausführen, Policy-Revision erhöhen und beide Werte
  kontrolliert ausrollen.
- **Entfernen:** Vorab betroffene Konten und Recovery-Bereitschaft ermitteln.
  Policy-Revision erhöhen. Das Modell wird ab der nächsten Assertion
  abgelehnt; bereits ausgestellte Sessions werden allein durch die ENV-Änderung
  nicht widerrufen.
- **Global deaktivieren:** Allowlist leeren und gleichzeitig eine höhere
  Policy-Revision ausrollen. Der neue deaktivierte Hash verdrängt alte
  Replicas; dieselbe Revision mit abweichendem Hash wird abgewiesen.
- **MDS-Statusänderung:** `REVOKED`, `NOT_FIDO_CERTIFIED`, Self-Assertion,
  Kompromittierungs-, unbekannte oder fehlende Statusdaten blockieren die
  nächste Assertion nach Übernahme des neuen Snapshots. Ohne separaten
  Push-/Refresh-Job kann das bis zu einer Stunde dauern. Falls aktive Sessions
  sofort beendet werden müssen, ist zusätzlich der dokumentierte
  Session-Widerruf auszuführen.
- **Signer-/Intermediate-Wechsel:** Die Zertifikate im geschützten `x5c`-Header
  regelmäßig beobachten. Kündigt FIDO einen Identitäts- oder
  Intermediate-Wechsel an, die neuen exakten Werte und die vollständige Kette
  außerhalb der Produktion prüfen, Testfälle und Freigabe im Code aktualisieren
  und das Release vor dem Wechsel ausrollen. Die Prüfung nicht über eine
  breitere Root- oder Organisationsfreigabe lockern.

Jede Änderung ist mit Zeitpunkt, freigegebenen Modellfamilien, Prüfer,
Testnachweisen und geplantem Rollback in der Betriebsdokumentation
festzuhalten. Eine AAGUID-Allowlist ist keine Beschaffungs- oder
Inventarliste einzelner Geräte.

## 5. Datenschutz

Bei der Registrierung erhält TaxTronik die vollständige Attestation und wertet
deren Zertifikatskette aus. Persistiert werden Credential-ID, Public Key,
Signaturzähler, AAGUID, Geräte-/Backup-/Transportangaben,
Attestationsformat, Prüfzeitpunkt und die attestierte Authenticator-/Firmware-
Version; die rohe Attestation-Zertifikatskette wird vom aktuellen
Anwendungspfad nicht gespeichert. Der private Schlüssel verlässt den
Authentikator nicht.

Die AAGUID kann die verwendete Modellfamilie offenlegen. Der Abruf des
vollständigen MDS-BLOBs übermittelt nach aktuellem Anwendungspfad keine Staff-
ID, Credential-ID oder AAGUID als Anwendungsparameter an den MDS-Anbieter;
dieser erhält jedoch die üblichen Verbindungsdaten des App-Servers wie
IP-Adresse und Abrufzeitpunkt. Dasselbe gilt für benötigte CA-CRL-Endpunkte.
Verantwortliche müssen Datenminimierung,
Informationspflichten, VVT/DSFA, Providerrolle, Vertragslage und möglichen
Drittlandsbezug für ihr Deployment selbst bewerten.

## 6. Wiederanlauf-Check

- [ ] `.env` samt beabsichtigter Allowlist und zugehöriger
      `WEBAUTHN_HARDWARE_POLICY_REVISION` wiederhergestellt; alle Replicas
      verwenden dieselbe Revision und denselben Hash
- [ ] Systemzeit, DNS und TLS-Egress zu `mds.fidoalliance.org:443` funktionieren
- [ ] Benötigte CA-CRL-Ziele sind ohne Redirect auf Port 80/443 erreichbar
- [ ] Migration und Owner-Zugriff auf `fido_mds_trust_state` funktionieren; die App-Rolle hat keine Tabellenrechte und nur EXECUTE auf den exakten Serien-/Policy-Lock-Guard
- [ ] Geschützte MDS-`x5c`-Kette entspricht der im Release freigegebenen Signeridentität
- [ ] Keine `staff-webauthn`-Readiness- oder Attestationswarnung im Testlauf
- [ ] Enrollment mit gültigem Firmware-Nachweis eines freigegebenen Testmodells erfolgreich
- [ ] Assertion mit jedem getrennt verwahrten Testschlüssel erfolgreich
- [ ] Fehlender beziehungsweise zu alter Firmware-Nachweis wird fail-closed abgelehnt
- [ ] Nicht freigegebenes Modell und leere Allowlist werden fail-closed
      abgelehnt; eine höhere Revision mit leerer Allowlist deaktiviert alte
      Replicas global
- [ ] Recovery für normales Staff-Konto und ADMIN-Owner-Pfad organisatorisch bereit
