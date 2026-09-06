# Technische Modulbeschreibung: Zugriffsschutz und Benutzerverwaltung

## Zweck

Berufsträgerqualifikation und optionale DATEV-Beraternummer werden unabhängig
von technischen Rollen gepflegt. Die Qualifikation erhöht keine Admin-, Audit-
oder Abrechnungsrechte. Bei GwG-Entscheidungen werden aktives Konto, Qualifikation
und ausdrückliche Mandatszuordnung frisch aus der Datenbank geprüft. Ein Entzug
lässt historische Freigaben und Zuordnungen erhalten; die Benutzerverwaltung
zeigt dadurch unbesetzte Mandate. Migrationswerte aus vorhandenen ausdrücklichen
Berufsträgerzuordnungen bleiben bis zur manuellen Bestätigung als Altzuordnung
erkennbar. Die Beraternummer ist optionaler Text ohne DATEV-Synchronisation.

Zwei strikt getrennte Anmeldekontexte (Kanzlei/Staff und Mandanten/Portal),
rollenbasierte Berechtigungen, Mandantentrennung in Tiefenstaffelung
(App-Guards + Postgres-RLS) und vollständige Anmelde-Protokollierung.

## Authentifizierung

- **Staff, Standardmodus:** Passwort (bcrypt cost 12, min. 12 Zeichen bei
  Anlage und Änderung) + **TOTP-Pflicht** (Self-Enrollment beim Erstlogin,
  60-min-Fenster, serverseitig erzeugter QR; Secret verschlüsselt; 8 einmalige
  zehnstellige Backup-Codes, bcrypt-gehasht, atomarer Konsum; TOTP-Replay-Schutz
  via Redis SET NX, fail-closed). Das reguläre Loginfeld akzeptiert entweder
  sechs TOTP-Ziffern oder einen vollständigen Recovery-Code; Beschriftung,
  Formatprüfung und mobile Tastatur unterstützen beide Wege. Die Prüfung und
  der Einmalverbrauch erfolgen unverändert auf dem Server
  (`ACCESS-TENANT-RLS-001`).
- **Staff, optionaler Hardware-only-Modus:** Ein Mitarbeiter kann im eigenen
  Profil mindestens zwei geeignete physische FIDO2-Sicherheitsschlüssel
  registrieren und den Modus danach mit einer WebAuthn-Assertion bewusst
  aktivieren. Solange er aktiv ist, akzeptiert die Staff-Anmeldung
  ausschließlich einen registrierten Schlüssel; Passwort, TOTP und
  Backup-Code sind keine Fallback-Anmeldewege. Die Schlüsselliste bleibt bis
  zur ebenfalls schlüsselbestätigten Deaktivierung gesperrt.
- **Hardware-Policy:** Registrierung, Moduswechsel und Anmeldung verlangen
  User Verification. Die Registrierung fordert `cross-platform`, ein
  discoverable Credential und `singleDevice`; gesicherte Credentials werden
  abgelehnt. Zulässig sind ausschließlich gemeldete Hardware-Transporte USB,
  NFC, BLE oder Smartcard; `internal`, `hybrid` und `cable` werden abgelehnt.
  Die WebAuthn-Zeremonie ist fünf Minuten gültig, in Redis atomar einmalig
  konsumierbar und an Purpose, RP ID sowie Origin gebunden. Registrierung,
  Moduswechsel, Credential-Widerruf und Recovery binden zusätzlich die
  `authRevision` der signierten Staff-Session; ein zwischenzeitlicher
  Sicherheits- oder Moduswechsel macht die Zeremonie unbrauchbar.
- **Verbindliche Attestation:** Hardware-Enrollment setzt eine nichtleere
  `WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST` voraus. Die positive, monoton zu
  erhöhende `WEBAUTHN_HARDWARE_POLICY_REVISION` bindet den Aktivstatus und den
  kanonischen Hash der sortierten Allowlist clusterweit. Eine leere Allowlist
  bindet einen global deaktivierten Zustand; bei Änderungen ist die Revision
  zu erhöhen. Das Enrollment fordert
  `attestation: direct` und akzeptiert nur eine vollständige `packed`-
  Attestation mit Zertifikatskette. Der FIDO Metadata Service (MDS) wird aus
  einem selbst verifizierten signierten Gesamt-BLOB `strict` initialisiert.
  Der vollständige MDS-Eintrag muss einen aktuell wirksamen
  `FIDO_CERTIFIED*`-Status enthalten; außer `UPDATE_AVAILABLE` werden alle
  anderen oder unbekannten Statuswerte abgewiesen. Das aktuelle Metadata
  Statement muss die AAGUID, Attestation Roots, `basic_full`, Hardware- oder
  Secure-Element-Schlüsselschutz und einen externen Nicht-Plattform-Authentikator bestätigen;
  Software- und Remote-Handle-Klassifizierung werden abgelehnt. Vor jeder
  Assertion werden die aktuelle Deployment-Allowlist und das MDS-Statement
  erneut geprüft. Leere Allowlist, fehlende oder kompromittierte Metadaten und
  MDS-/Netzfehler sperren Enrollment beziehungsweise Assertion fail-closed.
- **Attestationsgrenzen und Modellbindung:** Noch vor einem Netzzugriff gelten
  feste Grenzen für Registrierungsantwort, Attestation-Objekt und die ein bis
  fünf Zertifikate der `x5c`-Kette. Die gesamte Registration-Verifikation ist
  auf 30 Sekunden begrenzt. Das nichtkritische AAGUID-Attribut im
  Attestationszertifikat ist verpflichtend und muss exakt zur signierten
  Authenticator-AAGUID passen.
- **Signer- und Firmware-Bindung:** Der geschützte MDS-JWT-Header muss `RS256`
  und eine eng freigegebene Blatt-/Intermediate-Identität für
  `mds.fidoalliance.org` enthalten, bevor SimpleWebAuthn Signatur, Kette und
  Sperrlisten prüft. Eine Kette muss vor jedem CRL-Abruf exakt an einer
  freigegebenen Root enden; CA-BasicConstraints, KeyUsage, Pfadlänge und
  kritische Extensions werden fail-closed validiert. CRLs werden an den
  tatsächlichen Issuer, Signatur, AKI/SKI und Gültigkeitszeitraum gebunden;
  Redirects sind gesperrt und der Cache ist begrenzt. Nur ein einzelner
  unpartitionierter Voll-CRL-Distribution-Point ist zulässig; mehrere Namen,
  Reason-/Issuer-Scope, Zertifikat-seitige Freshest-CRL-Verweise,
  Delta-/IDP-/Freshest-CRLs und unbekannte kritische CRL-Extensions werden
  abgewiesen. Aus dem
  Attestationszertifikat wird die FIDO-Firmware-Extension als uint32 gelesen.
  Der Wert muss die Mindestversionen aus
  Metadata Statement und wirksamem Zertifizierungsreport erfüllen, wird
  unveränderlich gespeichert und bei jeder Assertion erneut verglichen.
  Fehlende Bestandswerte sperren das Credential bis zur Neuregistrierung.
- **Grenze des Nachweises:** Die verifizierte Attestation ordnet ein
  Credential einer freigegebenen Authentikator-Modellfamilie zu. Eine AAGUID
  ist keine Seriennummer oder eindeutige Gerätekennung; zwei registrierte
  Credentials beweisen daher nicht kryptografisch zwei verschiedene physische
  Geräte. `authenticatorAttachment` und `response.transports` bleiben
  clientseitige Zusatzsignale. Beim Aktivieren wird nur ein Schlüssel frisch
  per Assertion bestätigt; mindestens zwei aktive Credentials müssen jedoch
  die aktuelle Allowlist-/MDS-/Provenienzprüfung bestehen. Die getrennte
  Funktionsprüfung und Verwahrung beider Schlüssel bleibt organisatorisch.
- **MDS-Betrieb und Datenschutz:** Der App-Container benötigt DNS, korrekte
  Systemzeit, eine gültige TLS-Vertrauenskette, HTTPS-Egress zum FIDO-MDS und
  eng begrenzten HTTP(S)-Egress zu den CRL-Endpunkten der validierten
  CA-Ketten. Beim Produktionsstart wird nur die lokale Policy-Revision samt
  Hash gegen die Datenbank gebunden; dabei erfolgt kein MDS-/CRL-Netzzugriff.
  MDS-Initialisierung und Refresh erfolgen erst bedarfsgetrieben, spätestens
  nach einer Stunde beziehungsweise zum früheren `nextUpdate`. Der Snapshot
  ist prozesslokal. Nach kryptografischer BLOB-Prüfung wird seine signierte
  Seriennummer dagegen clusterweit monoton verankert, bevor die lokale
  Allowlist-/Modellfilterung erfolgt. Auch ein gültiger neuer BLOB ohne lokal
  nutzbares Modell verdrängt damit alte Serien und sperrt den aktuellen
  Hardware-Vorgang fail-closed. Eine DB-Tabelle ohne App-Tabellenrechte hält
  Seriennummer, Policy-Revision und kanonischen Policy-Hash. Ein enger
  SECURITY-DEFINER-Guard vergleicht und share-lockt dieses exakte Tripel bei
  jeder sicherheitsrelevanten WebAuthn-Mutation bis zum Commit. Höhere
  Revisionen verdrängen ältere Replicas; dieselbe Revision mit abweichendem
  Hash und niedrigere Revisionen werden abgewiesen. Der MDS-Lock wird stets vor
  den Staff-Locks genommen (`MDS -> Staff`). Ein Ausfall erzeugt keinen
  Software-Fallback. Gespeichert werden
  AAGUID, Attestationsformat, Prüfzeitpunkt und
  attestierte Authenticator-/Firmware-Version, nicht die rohe
  Zertifikatskette; der MDS-Abruf hinterlässt beim externen Dienst
  Server-Verbindungsdaten. Betrieb, Signerwechsel und Datenschutzgrenzen
  stehen im [FIDO-MDS-Runbook](../../operations/fido-mds.md).
- **Portal:** ausschließlich Magic-Link (32-Byte-Token, nur SHA-256-Hash in
  DB, 30 min TTL, atomarer One-Time-Consume in einer Tx mit Audit,
  POST-Consume gegen Mail-Scanner-Prefetch, Anti-Enumeration mit
  Zufalls-Latenz, Versand-Throttle).
- **Lockout/Rate-Limits:** IP-Limits je Login-Schritt; Kontosperre erst bei
  Fehlversuchen von ≥5 **distinkten** Quell-IPs (kein Fremd-Lockout);
  fail-closed bei Redis-Ausfall in Produktion; X-Forwarded-For wird ohne
  `TRUST_PROXY_REQUIRED` nicht vertraut.
- **Sessions:** `__Host-`-Cookies, getrennte Auth.js-Instanzen je Surface,
  per-Request-Revalidierung (aktiv? GwG-Freigabe? anonymisiert?). Staff-Tokens
  sind zusätzlich an `authRevision` und den zum Kontomodus passenden
  Authentisierungstyp gebunden. Expliziter Logout, Deaktivierung und
  Rollenänderungen nutzen zusätzlich die Redis-Revocation. Eigene
  Passwortänderung, reguläre Passwort-/TOTP-Sicherheitsresets,
  Hardware-Modusänderung und Hardware-Recovery verwenden dagegen die in
  derselben Datenbanktransaktion atomar erhöhte `authRevision` als
  autoritativen Cutoff; dadurch entsteht vor Lock, Zustandsvergleich und Audit
  kein externer Widerrufs-Seiteneffekt. Alte JWTs scheitern beim nächsten
  frischen DB-Abgleich. Lesen eines Redis-Widerrufszeitpunkts und Aktionen, die
  ihn ausdrücklich schreiben müssen, sind fail-closed; ein Redis-Ausfall kann
  Sessions weiterhin vorübergehend ablehnen.
- **Kontowiederherstellung:** Jeder Mitarbeiter kann sein Passwort im eigenen
  Benutzerprofil nach Prüfung des bisherigen Passworts ändern (Rate-Limit,
  Bestätigung, anschließender Logout auf allen Geräten). Dabei werden auch
  eigene, noch aktive Hardware-Credentials widerrufen, die im Passwortmodus
  bereits registriert, aber noch nicht für Hardware-only aktiviert waren.
  ADMIN können fremde PARTNER-/EMPLOYEE-Passwörter und -TOTP-Zuordnungen
  zurücksetzen, PARTNER nur die von EMPLOYEE. Diese Sicherheitsresets prüfen
  Actor und dessen erwartete `authRevision` frisch unter Datenbanklocks und
  widerrufen sämtliche noch aktiven Hardware-Credentials des Zielkontos,
  einschließlich ruhender Vorabregistrierungen. Secret, offenes Setup und
  Backup-Codes werden gemeinsam entfernt. Bei Verlust aller physischen
  Schlüssel gibt es bewusst keinen
  Passwort-, TOTP- oder Backup-Code-Bypass: Der getrennte Hardware-Recovery-
  Pfad folgt derselben Hierarchie. Ein Akteur im Passwort-/TOTP-Modus muss sein
  aktuelles Passwort und einen durch den Replay-Schutz frisch konsumierten
  echten TOTP vorlegen; Backup-Codes werden als Step-up nicht akzeptiert. Ein
  Hardware-only-Akteur bestätigt mit seinem eigenen registrierten Schlüssel.
  Die kurzlebige Einmal-Challenge bindet dabei Purpose, Tenant, Actor,
  Zielkonto und aktuelle Actor-`authRevision`.

  Nach erfolgreichen Vorabprüfungen ist die SECURITY-DEFINER-Prozedur der
  erste Datenbank-Lock-/Mutationsschritt. Sie nimmt Actor- und Target-Locks in
  deterministischer Reihenfolge und prüft Active-Status, Rollen,
  Zielhierarchie und Hardwaremodus unter den gehaltenen Locks frisch. Danach
  werden der Actor-Zustand per Compare-and-swap abgesichert und
  Schlüsselwiderruf, Deaktivierung von Hardware-only, neues Passwort, offenes
  TOTP-Enrollment, `authRevision` und Audit in derselben Datenbanktransaktion
  abgeschlossen. `authRevision` und der neue Modus verwerfen vorherige
  Hardware-Sessions beim nächsten Request. Ein Parallelkonflikt rollt diese
  Datenbankänderungen gemeinsam zurück, ohne davor einen separaten Redis-
  Logout des Zielkontos zu hinterlassen. ADMIN-Konten sind von den Web-Resets ausgeschlossen;
  Passwort, TOTP und Hardware-Zugang werden ausschließlich über
  `reset-admin-password` per Owner-CLI wiederhergestellt. `ADMIN_EMAIL` und
  `TENANT_SLUG` sind dabei verpflichtend; die CLI mutiert nur bei genau einem
  Treffer, erhöht die Auth-Revision und bricht sonst fail-closed ab. Reset,
  Schlüsselwiderruf und das tenantgebundene `SYSTEM`-Ereignis
  `staff.hardware_access.reset` liegen in derselben Datenbanktransaktion. Die
  Credential-Datei wird mit `O_EXCL` und No-follow-Schutz vor dem Commit
  angelegt. Das Klartextpasswort erscheint ausschließlich in dieser Datei,
  niemals auf `stdout`, `stderr` oder in Logs. Auf POSIX werden `0600`, Datei-
  `fsync` und anschließend `fsync` des Elternverzeichnisses erzwungen.
  Existierendes Ziel oder Ausgabefehler rollen den Reset zurück; eine nur von
  diesem Versuch erzeugte Teildatei wird gezielt entfernt. Scheitert erst der
  Datenbank-Commit, kann die bereits sicher geschriebene, aber unwirksame Datei
  zurückbleiben und muss anhand des CLI-Fehlers verworfen werden.
  Bekannte Hardware-Credentials erzeugen auch bei abgewiesener Anmeldung ein
  generisches `auth.login.failure`; Credential-ID, AAGUID, E-Mail und internes
  Verifikationsdetail werden nicht protokolliert. Für unbekannte Credentials
  entsteht mangels sicher bestimmbaren Tenants bewusst kein Audit-Ereignis.

## Autorisierung

- Rollen: ADMIN/PARTNER (= allgemeine Admin-Funktionen) / EMPLOYEE; min. 1
  Rolle, Selbständerung gesperrt. Kontowiederherstellung und Verwaltung der
  Recovery-Rollen folgen zusätzlich einer server- und datenbankseitigen
  Hierarchie: Kein Staff-Akteur darf eine ADMIN-Rolle entziehen; eine
  PARTNER-Rolle darf nur ein aktiver ADMIN desselben Tenants entziehen.
  PARTNER können keine ADMIN-Konten deaktivieren oder ADMIN-Rollen vergeben.
- **Einzelrechte (iter87):** `staff_permission` je Mitarbeiter —
  `CLIENT_CREATE` (Mandantenanlage),
  `PAYROLL_MANAGE` (gesondert geschützte Personalvorgänge),
  `INBOUND_MAIL_MANAGE` (interner Posteingang),
  `PORTAL_INBOX_MANAGE` (sicheren Mandantenposteingang bearbeiten),
  `INVOICE_MANAGE` (Rechnungen anlegen/bearbeiten, Zahlung/Storno),
  `INVOICE_SEND` (versenden = Festschreibung, EXTERNAL-Upload),
  `ABSENCE_DECIDE` (Urlaub entscheiden, Abwesenheitsmeldungen erhalten).
  ADMIN/PARTNER implizit alles (`hasStaffPermission`); Durchsetzung im
  zentralen Gate (`staffActionGuard({ requirePermission })`), UI-Ausblendung
  ist nur Komfort. Vergabe/Entzug Admin-only, Selbständerung gesperrt,
  Entzug beendet Sitzungen sofort (Revocation + per-Request-Frischladung
  der Rechte aus der DB). Update-Migration verteilt `INVOICE_*` an alle
  Bestandsmitarbeiter (auch deaktivierte — sie behalten die Rechte bei
  späterer Reaktivierung; kein Verhaltensbruch), `ABSENCE_DECIDE` bleibt
  bei Admin/Partner bis zur expliziten Delegation.

Der Mandantenposteingang kombiniert `PORTAL_INBOX_MANAGE` stets mit dem
aktuellen Mandantenzugriff. Das Einzelrecht allein erlaubt weder Liste, Suche,
Detail, Antwort, Anlage noch Notification. Ein Rechteentzug wirkt über RLS auch
auf bereits vorhandene Inbox-Notifications. Bestandsmitarbeiter erhalten das
neue Recht nicht automatisch; ADMIN/PARTNER erfüllen es im bestehenden
Rollenmodell implizit.

- Mandantenzugriff: Policy OPEN (alle aktiven Staff außer vertrauliche
  Mandanten) oder RESTRICTED (nur Zuständige laut `ClientResponsibility`);
  zentral `canAccessClient(Tx)` + `inaccessibleClientIdsFor` für Mengen.
- **RLS-Backstop:** App-Rolle `taxtronik_app` ohne BYPASSRLS; jede Query
  via `withTenantContext` (`set_config('app.current_tenant_id', …)`) gegen
  FORCE-RLS-Policies; Owner-Verbindung nur Migration/CLI/Worker; App-Client
  fail-closed ohne Owner-Fallback.
- Maschinelle Guards: alle ~225 Server-Actions müssen ein Auth-Primitiv
  referenzieren (AST-Test), jede `new PrismaClient`-Stelle steht auf einer
  begründeten Allowlist.

## Protokollierung

`auth.login`(+Methode)/`auth.login.failure`/`auth.login.lockout`,
`auth.totp.enroll`, `auth.backup_code.consume`, `auth.magic_link.consume`,
`staff.create/.roles.update/.permissions.update/.activate/.deactivate/.skills.update`,
`staff.password.change/.password.reset/.totp.reset`,
`staff.security_key.register/.remove`, `staff.hardware_only.enable/.disable`,
`staff.hardware_access.reset`,
`client_contact.create/.update/.deactivate` — alle in der Hash-Chain.

## Traceability

| Anforderung                                       | Implementierung                            | Test                                                                                                              |
| ------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Cross-Tenant unmöglich (DB-Ebene)                 | RLS-Policies                               | `rls-cross-tenant.test.ts` (CI-Pflicht)                                                                           |
| Kein Owner-Fallback                               | db/client fail-closed                      | `client-fail-closed.test.ts`                                                                                      |
| Magic-Link-Lebenszyklus                           | auth/magic-link                            | `magic-link.test.ts` + Security-Audit 2026-06 (One-Time/Replay/Prefetch verifiziert)                              |
| Lockout ohne Fremd-Aussperrung                    | auth/lockout                               | `lockout.test.ts`                                                                                                 |
| TOTP-Helfer                                       | auth/totp                                  | `totp.test.ts`                                                                                                    |
| Passwort-/2FA-Kontowiederherstellung              | profile + admin/users actions              | `profile/__tests__/actions.test.ts` + `admin/users/__tests__/account-actions.test.ts`                             |
| Physische WebAuthn-/MDS-Policy                    | auth/webauthn + DB-Policyanker + CRL-Patch | `webauthn.test.ts` + `simplewebauthn-crl-hardening.test.ts` + Config-/DB-/Supply-Chain-Tests                      |
| Hardware-Modus, Fallback und Recovery             | staff auth + profile/admin/Owner-CLI       | `staff-auth-state.test.ts` + `totp-enrollment.test.ts` + Profil-/Admin-Action-Tests + `admin-break-glass.test.ts` |
| Credential-Tenantgrenze (`ACCESS-TENANT-RLS-001`) | WebAuthn-Migration + FORCE RLS             | `staff-webauthn-migration.test.ts` + `staff-webauthn-rls.test.ts`                                                 |
| Audit-Kopplung (`AUDIT-HASH-CHAIN-001`)           | WebAuthn-/Modus-/Recovery-Actions          | `profile/__tests__/actions.test.ts` + `admin/users/__tests__/account-actions.test.ts`                             |
| Zugriffspolicy-Wahrheitstabelle                   | settings/access-policy                     | `access-policy.test.ts`                                                                                           |
| Einzelrechte (implizit/Grant/fail-closed)         | rbac.hasStaffPermission + decideStaffGuard | `rbac.test.ts` + `staff-action.test.ts` (Wahrheitstabellen)                                                       |
| Fehler ohne Internals                             | rbac.toActionError                         | `rbac.test.ts`                                                                                                    |
| Open-Redirect-Schutz                              | safePortalReturnTo                         | `safe-return-to.test.ts`                                                                                          |
| GwG-Sperre Portal-Zugang                          | DB-Trigger + Session-Check                 | `gwg-allow-active.test.ts` + portal.ts-Revalidierung                                                              |
| Alle Actions geguarded                            | AST-Scan                                   | `server-action-authz.test.ts`                                                                                     |
| Inbox-RLS und Rechteentzug                        | Inbox-Policies + Safe-Projection           | `portal-inbox-rls.test.ts`                                                                                        |

## Autorisierungsidentische Suche

Suchtreffer, Trefferzähler und Filter dürfen nur Objekte berücksichtigen, die
der Akteur im selben aktuellen Kontext öffnen darf. Für die Inbox bedeutet das:

- Portal: nur abgesendete Threads des eigenen Mandanten; offene Batches nur
  für ihren Ersteller.
- Staff: `PORTAL_INBOX_MANAGE`, Featurestatus und Mandantenzugriff gelten
  gemeinsam.
- Betreff und zugelassene Mandantenmetadaten sind suchbar; Nachrichtentext,
  Anlagenbytes, OCR- und Scannerinhalte sind es in Version 0.3 nicht.
- Der Deep-Link prüft den Zugriff erneut; ein alter Treffer ist keine
  Capability.
- Suchbegriffe werden nicht in Audit, Notification oder gewöhnliche Logs
  kopiert.

Der Trigramindex des Inbox-Moduls liegt ausschließlich auf dem Thread-Betreff.
Eine zukünftige Inhalts- oder Nachrichtenvolltextsuche erfordert eine neue
Datenklassen-, Scope-, Retention- und Missbrauchsprüfung nach
`ACCESS-SEARCH-SCOPE-001`.

## Bekannte Grenzen

Es gibt bewusst keinen automatischen Passwort-Ablauf und keine Passwort-
Historie. Ein Benutzer kann seine bestehende TOTP-Zuordnung nicht selbst
entfernen. Bei Verlust von Authenticator und Backup-Codes erfolgt der
auditierte Web-Reset durch eine übergeordnete Rolle; für ADMIN-Konten ist
bewusst ausschließlich die Operator-CLI vorgesehen.

Der Hardware-only-Modus ist phishing-resistenter als ein Passwort-/TOTP-Login.
Die vollständige `packed`-Attestation, die Deployment-Allowlist und FIDO MDS
`strict` grenzen die zulässigen Credentials auf geprüfte Modellfamilien ein.
Sie beweisen weder eine bestimmte Seriennummer noch, dass zwei Credentials von
zwei unterschiedlichen physischen Geräten stammen. Attachment und Transporte
bleiben nicht attestierte Clientangaben. Die Kanzlei muss beide Schlüssel daher
getrennt beschaffen, testen, kennzeichnen und verwahren.

MDS-, DNS-, TLS- oder Egress-Ausfall sowie eine leere Allowlist sperren jede
neue Hardware-Assertion fail-closed. Es gibt keinen automatischen Passwort-
oder TOTP-Fallback. Verlust aller registrierten Schlüssel oder ein anhaltender
MDS-Ausfall erfordert den hier dokumentierten hierarchischen Break-glass-
Prozess. Ein Wechsel von Hostname oder Origin ändert RP-Bindung beziehungsweise
Origin-Prüfung und muss deshalb vor einem produktiven Domainwechsel mit den
registrierten Schlüsseln getestet und in die Recovery-Planung aufgenommen
werden.

Schlüsselmodelle mit mehreren, partitionierten, indirekten oder Delta-CRLs
sind derzeit bewusst nicht kompatibel und werden statt einer unvollständigen
Sperrauskunft fail-closed abgewiesen. Die konkrete Herstellerkette ist deshalb
vor Aufnahme ihrer AAGUID in die Allowlist zu testen.

Der bei Registrierung attestierte Firmware-Wert ist kein Live-Telemetriekanal:
Eine spätere Firmware-Aktualisierung oder ein Downgrade wird durch eine normale
Assertion nicht neu attestiert. Hebt FIDO die MDS-Mindestversion an, bleibt ein
Credential mit älterem gespeicherten Wert deshalb gesperrt, bis der Schlüssel
mit einer aktuell passenden Attestation neu registriert wurde. Auch ein
MDS-Signer-/Intermediate-Wechsel kann wegen der engen Identitätsbindung einen
koordinierten Release vor dem externen Wechsel erforderlich machen.

## Sitzungswiderruf bei Cookie-Erneuerung

ACCESS-TENANT-RLS-001: JWT-Erneuerung, Session-Callback und direkte Server-Auth
verwenden dieselbe laufende Konto-/Mandatsprüfung. Ein widerrufenes Token wird
vor dem Ausstellen eines Ersatzcookies verworfen. `sessionIssuedAt` bleibt als
signierter ursprünglicher Anmeldezeitpunkt über Erneuerungen erhalten. Ältere
Tokens ohne diesen Wert werden verworfen: Ihr `iat` kann durch die bisherige
Erneuerung bereits verschoben sein. Nach dem Deployment ist deshalb für
bestehende Staff- und Portal-Sitzungen einmalig eine neue Anmeldung nötig.
Auch ein parallel gesetzter Widerruf wird nicht durch ein frisches `iat` überholt.
Redis- und DB-Ausfälle erlauben keine Erneuerung. Der reale Auth.js-HTTP-Pfad
wird in `session-renewal.test.ts` mit simulierten Persistenzgrenzen geprüft.

Auch der direkte Staff-Passwort-Formularpfad für den lokalen TOTP-Testmodus
und der Portal-Session-Schreiber für Magic-Link und Profilwechsel setzen
`sessionIssuedAt` beim Ausstellen. Andernfalls folgt auf einen erfolgreichen
Login sofort die Abweisung durch die Server-Auth. Die Regression prüft diese
echten Ausgabepfade einschließlich Cookie-Erneuerung und anschließendem
Widerruf; die Ablehnung alter Cookies ohne Claim bleibt unverändert.

CLIENT-MANDATE-LIFECYCLE-001: Auch unabhängige Kalenderabonnements prüfen das
aktuelle Mandatsende vor dem Laden von Terminen und Fristen.
