# ADR 0010 — Session-Strategie (JWT) und Cookie-Scope

**Status**: Aktualisiert und akzeptiert
**Datum**: 2026-05-13 · aktualisiert 2026-09-03
**Kontext**: Security-Review S11 (JWT-Sessions ohne Revocation) und S12
(Cookies mit `path: '/'` statt `/staff`/`/portal`) hat die aktuelle
Auth-Konfiguration hinterfragt. Beide Punkte sind nicht "kritisch", aber
relevant für Defense in Depth.

## Entscheidung

### Sessions: JWT statt Database-Sessions

`session: { strategy: 'jwt' }` in beiden Surfaces ([staff.ts](../../apps/web/src/server/auth/staff.ts),
[portal.ts](../../apps/web/src/server/auth/portal.ts)).

**Begründung**:

- JWT-Sessions sind in NextAuth v5 der Default und für die meisten
  on-premise-Installationen ausreichend.
- Database-Sessions würden pro Request eine Postgres-Query auf
  `Account`/`Session` Tabellen erzeugen — bei einer Single-Tenant-Kanzlei
  mit 5–20 Mitarbeitern unnötiger Overhead.
- Hash-Chain und Audit-Log machen sicherheitskritische Operationen
  nachvollziehbar (siehe [ADR 0004](0004-evidence-chain-mit-rfc3161.md)),
  verhindern aber keine Aktion mit einem gestohlenen gültigen Session-Cookie.
  Kurze TTL, sofortiger Widerruf und der für den Kontomodus zulässige Faktor
  bei der Neuanmeldung bleiben deshalb eigenständige Kontrollen.

**Aktueller Widerruf:** Sessions bleiben stateless JWE, werden aber gegen einen
serverseitigen Redis-Widerrufszeitpunkt je Surface und Benutzer geprüft.
Expliziter Logout, Deaktivierung und Rollenänderungen schreiben diesen
Zeitpunkt. Ein fehlgeschlagener ausdrücklich benötigter Redis-Widerruf darf dem
Operator nicht als erfolgreicher Abschluss gemeldet werden.
Auch ein Fehler beim Lesen des Widerrufszeitpunkts lehnt die Session ab
(fail-closed); Redis-Ausfälle können Authentifizierung und bestehende Sessions
daher vorübergehend blockieren. Die Token-TTL bleibt zusätzliche Begrenzung,
nicht der einzige Schutz.

Staff-Tokens tragen außerdem `authRevision` und die Anmeldemethode. Bei jedem
Request muss die Revision dem aktuellen Konto entsprechen; ein Konto im
Hardware-only-Modus akzeptiert nur eine `security_key`-Session, im
Passwort/TOTP-Modus keine solche Session. Eigene Passwortänderungen,
administrative Passwort-/TOTP-Sicherheitsresets sowie Hardware-Moduswechsel
und -Recovery erhöhen die Revision atomar mit der Sicherheitsmutation und dem
Audit. Sie brauchen nach dem eingelösten Session-Guard keinen zusätzlichen
Redis-Schreibzugriff; alte JWTs scheitern beim nächsten frischen DB-Abgleich.
Der ADMIN-Break-glass-Pfad über die Owner-CLI kann keinen Redis-Widerruf
ausführen, erhöht aber ebenfalls die Revision und sperrt alle registrierten
Schlüssel, sodass bestehende Staff-Tokens bei der nächsten Revalidierung
abgelehnt werden.

Mitigations und Grenzen:

- TTL des JWT: in beiden Auth-Konfigurationen 24 Stunden
- `AUTH_SECRET` rotieren entwertet alle Tokens sofort (kickt alle aus, aber
  funktioniert als Emergency-Reset).
- TOTP beziehungsweise die WebAuthn-Assertion schützt die Neuanmeldung, nicht
  die Nutzung eines bereits gestohlenen Session-Cookies.
- Im aktivierten Hardware-only-Modus sind Passwort, TOTP und Backup-Code keine
  Anmelde-Fallbacks. Verlust aller Schlüssel führt in den hierarchischen
  Recovery-Pfad; dieser setzt wieder Passwort plus neues TOTP-Enrollment. Der
  Web-Reset verlangt vom Akteur aktuelles Passwort plus frischen TOTP ohne
  Backup-Code oder bei eigenem Hardware-only-Modus eine WebAuthn-Assertion des
  eigenen Schlüssels. Die Challenge bindet Akteur, Zielkonto und aktuelle
  Auth-Revision; die Datenbankmutationen einschließlich Audit sind atomar.
- AAGUID-Allowlist und aktuelles FIDO-MDS-Statement werden vor jeder neuen
  Hardware-Assertion fail-closed geprüft. Policy-Revision und kanonischer
  Allowlist-Hash werden clusterweit gebunden; Hardware-Commits vergleichen
  zusätzlich die exakte MDS-Serie. Eine Allowlist-/MDS-Änderung
  widerruft bereits ausgestellte Sessions nicht von selbst; bei akuter
  Modellkompromittierung ist der separate Session-Widerruf erforderlich.
- Für Portal-Surface: Magic-Link-Token ist immer One-Time-Use (siehe
  [magic-link.ts:127-131](../../apps/web/src/server/auth/magic-link.ts)).

**Wann re-eval**: Wenn per-Gerät-Sessions, einzelne Session-Widerrufe oder ein
allgemeiner Widerruf außerhalb der revisionsgebundenen Staff-Workflows ohne
Redis-Verfügbarkeitsabhängigkeit verlangt werden, ist eine persistente
Session-/JTI-Tabelle mit RLS neu zu bewerten.

### Cookie-Scope: `path: '/'` statt `/staff`/`/portal`

**Begründung**:

- `SameSite=Lax` hält das Cookie aus Cross-Site-POSTs heraus. Mutierende
  Routen und Server-Actions benötigen unabhängig davon ihre Fetch-Metadata-,
  Origin- beziehungsweise Framework-Prüfung; Top-Level-GETs können das Cookie
  weiterhin mitsenden.
- Beide Cookies haben **separate Namen** (`__taxtronik_staff_session` vs
  `__taxtronik_portal_session`) — das verhindert, dass ein Mandanten-Cookie
  versehentlich an einen Staff-Endpoint geht. Server-Code prüft via
  `staffAuth()` / `portalAuth()` immer die richtige Session-Quelle.
- Subdomain-Trennung (optional, siehe `STAFF_COOKIE_DOMAIN` /
  `PORTAL_COOKIE_DOMAIN` ENV) ist der eigentliche Defense-in-Depth-Hebel
  für produktive Installationen — `Path`-Restriktion ist nur ein schwacher
  Zusatz.

**Wann re-eval**: Wenn ein Pen-Test eine konkrete Pfad-bezogene CSRF-Lücke
findet, die durch Path-Scoping verhindert worden wäre. Bisher keine bekannt.

## Konsequenzen

- Wir behalten JWT + `path: '/'` als pragmatischen Default.
- Vor Produktivstart externer Pen-Test (siehe Plan, Iter. 7) — falls
  Befunde dazu kommen, ADR aktualisieren.
- Operations-Doku verweist auf `STAFF_COOKIE_DOMAIN` / `PORTAL_COOKIE_DOMAIN`
  als empfohlenen Hardening-Schritt für Multi-Standort-Kanzleien.

## Verworfene Alternativen

- **Database-Sessions sofort**: Overhead für kleine Kanzleien, kein
  konkreter Compliance-Treiber.
- **Cookie-Path strikt `/staff` bzw. `/portal`**: Bricht die `/api/auth/*`-
  Pfade, weil NextAuth eigene API-Routes hat. Workaround: Cookie-Pfad auf
  gemeinsamen Prefix beider Auth-Endpoints — nicht möglich, sie liegen
  unter `/api/auth/staff/*` und `/api/auth/portal/*`.
