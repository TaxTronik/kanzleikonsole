# ADR 0010 — Session-Strategie (JWT) und Cookie-Scope

**Status**: Aktualisiert und akzeptiert
**Datum**: 2026-05-13 · aktualisiert 2026-08-23
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
  Kurze TTL, sofortiger Widerruf und TOTP bei der Neuanmeldung bleiben deshalb
  eigenständige Kontrollen.

**Aktueller Widerruf:** Sessions bleiben stateless JWE, werden aber gegen einen
serverseitigen Redis-Widerrufszeitpunkt je Surface und Benutzer geprüft.
Logout sowie sicherheitsrelevante Passwort-/TOTP-Operationen widerrufen die
bisher ausgestellten Sessions. Ein fehlgeschlagener sicherheitskritischer
Widerruf darf dem Operator nicht als erfolgreicher Abschluss gemeldet werden.
Auch ein Fehler beim Lesen des Widerrufszeitpunkts lehnt die Session ab
(fail-closed); Redis-Ausfälle können Authentifizierung und bestehende Sessions
daher vorübergehend blockieren. Die Token-TTL bleibt zusätzliche Begrenzung,
nicht der einzige Schutz.

Mitigations und Grenzen:

- TTL des JWT: in beiden Auth-Konfigurationen 24 Stunden
- `AUTH_SECRET` rotieren entwertet alle Tokens sofort (kickt alle aus, aber
  funktioniert als Emergency-Reset).
- TOTP schützt die Neuanmeldung, nicht die Nutzung eines bereits gestohlenen
  Session-Cookies.
- Für Portal-Surface: Magic-Link-Token ist immer One-Time-Use (siehe
  [magic-link.ts:127-131](../../apps/web/src/server/auth/magic-link.ts)).

**Wann re-eval**: Wenn per-Gerät-Sessions, einzelne Session-Widerrufe oder ein
Widerruf ohne Redis-Verfügbarkeitsabhängigkeit verlangt werden, ist eine
persistente Session-/JTI-Tabelle mit RLS neu zu bewerten.

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
