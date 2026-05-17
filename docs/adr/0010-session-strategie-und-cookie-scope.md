# ADR 0010 — Session-Strategie (JWT) und Cookie-Scope

**Status**: Akzeptiert mit Vorbehalt (Iteration 1)
**Datum**: 2026-05-13
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
- Compliance-kritische Operationen sind ohnehin durch Hash-Chain + Audit-Log
  abgedeckt (siehe [ADR 0004](0004-evidence-chain-mit-rfc3161.md)) — ein
  kompromittiertes JWT ändert daran nichts.

**Bekannter Trade-off**: Bei gestohlenem Token gibt es serverseitig keinen
sofortigen Revoke. Mitigations:
- TTL des JWT: 24h (NextAuth Default)
- `AUTH_SECRET` rotieren entwertet alle Tokens sofort (kickt alle aus, aber
  funktioniert als Emergency-Reset).
- TOTP-Pflicht für Staff macht Login-Übernahme über Stolen-Cookie schwerer.
- Für Portal-Surface: Magic-Link-Token ist immer One-Time-Use (siehe
  [magic-link.ts:127-131](../../apps/web/src/server/auth/magic-link.ts)).

**Wann re-eval**: Wenn eine Kanzlei eine Token-Blacklist verlangt (z. B.
nach Datenschutzvorfall) → Migration zu Database-Sessions, Session-Tabelle
mit RLS einführen. Schätzaufwand: 1–2 Tage. Kein Schema-Lock-in: NextAuth
v5 kann zwischen jwt/database umschalten.

### Cookie-Scope: `path: '/'` statt `/staff`/`/portal`

**Begründung**:
- `SameSite=Lax` mitigiert Top-Level-CSRF bereits — der zweite Cookie ist
  durch Auth.js's CSRF-Token zusätzlich abgesichert.
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
