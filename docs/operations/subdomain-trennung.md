# Subdomain-Trennung Staff/Portal

Für produktive Kanzleien empfohlenes Setup: Mitarbeiter- und Mandanten-Surface
laufen auf getrennten Subdomains. Dadurch können die Surfaces unabhängig
zugänglich gemacht werden (z. B. Portal aus dem Internet, Staff nur aus dem
Kanzlei-LAN).

```
┌──────────────────────────────┐       ┌──────────────────────────────┐
│ staff.kanzlei.example.de     │       │ portal.kanzlei.example.de    │
│ ────────────────────────     │       │ ────────────────────────     │
│ /staff/* + /api/staff/*      │       │ /portal/* + /api/portal/*    │
│ /api/auth/staff/*            │       │ /api/auth/portal/*           │
│ /api/integrations/n8n/v1/*   │       │ /poa/sign, /gwg-onboarding   │
│ /api/n8n/* (Legacy-HMAC)     │       │                              │
└──────────────┬───────────────┘       └──────────────┬───────────────┘
               │                                      │
               └────────────┬─────────────────────────┘
                            ▼
                ┌─────────────────────────┐
                │ Reverse-Proxy (Caddy)   │
                │ (TLS-Termination)       │
                └────────────┬────────────┘
                             ▼
                    ┌─────────────────┐
                    │ Next.js (3000)  │
                    └─────────────────┘
```

## Schritte

### 1. DNS

Zwei A-/AAAA-Records auf den Server der Kanzlei zeigen lassen:

```
staff.kanzlei.example.de.   IN A   <server-ip>
portal.kanzlei.example.de.  IN A   <server-ip>
```

### 2. Reverse-Proxy (Caddy-Beispiel)

```caddy
staff.kanzlei.example.de {
  encode gzip
  # Nur Staff-Pfade durchreichen — Portal-Pfade werfen 404
  @staffPaths path /staff/* /api/staff/* /api/auth/staff/* /api/integrations/n8n/v1/* /api/n8n/* /api/health /_next/* /favicon.* /static/*
  handle @staffPaths {
    reverse_proxy localhost:3000
  }
  handle {
    respond "Not Found" 404
  }
}

portal.kanzlei.example.de {
  encode gzip
  @portalPaths path /portal/* /api/portal/* /api/auth/portal/* /poa/sign /poa/sign* /gwg-onboarding /gwg-onboarding* /api/health /_next/* /favicon.* /static/*
  handle @portalPaths {
    reverse_proxy localhost:3000
  }
  handle {
    respond "Not Found" 404
  }
}
```

> Wenn Mitarbeiter auch GwG-Onboarding-Links versenden, müssen die
> Wizard-Routen (`/gwg-onboarding`) sowohl auf Staff- als auch auf
> Portal-Subdomain erreichbar sein — die obige Caddy-Konfig erlaubt das
> nur über die Portal-Subdomain. Empfehlung: in den Mail-Templates
> immer die Portal-URL verwenden (= `NEXTAUTH_URL` der Portal-Subdomain).

### 3. ENV-Variablen

```env
# Staff-Subdomain als Haupt-URL
NEXTAUTH_URL=https://staff.kanzlei.example.de

# Mandanten-Links (Portal-Login, GwG-Onboarding, PoA-Signatur)
PORTAL_PUBLIC_URL=https://portal.kanzlei.example.de

# Cookie-Domains pro Surface — Subdomain-spezifisch (NICHT die Hauptdomain!)
STAFF_COOKIE_DOMAIN=staff.kanzlei.example.de
PORTAL_COOKIE_DOMAIN=portal.kanzlei.example.de
```

> **Wichtig:** Trage NIEMALS die übergeordnete Domain (z. B.
> `.kanzlei.example.de`) in beide ein. Sonst werden beide Cookies an
> beide Subdomains geschickt — die Surface-Trennung wäre kaputt.
>
> Wenn die `*_COOKIE_DOMAIN`-Variablen leer bleiben, sind die Cookies
> host-only, was im Subdomain-Setup ebenfalls die richtige Trennung gibt
> (jedes Cookie nur für seine Subdomain).

### 4. Mail-Links

Magic-Links für Portal-Login, GwG-Onboarding-Einladungen, PoA-Signatur etc.
nutzen `PORTAL_PUBLIC_URL` als Basis. `NEXTAUTH_URL` bleibt die Staff-/App-Basis
für Server-Callbacks und das Kanzlei-UI:

| Mail                         | Empfänger   | Basis-URL           |
| ---------------------------- | ----------- | ------------------- |
| Magic-Link Portal-Login      | Mandant     | `PORTAL_PUBLIC_URL` |
| GwG-Onboarding               | Mandant     | `PORTAL_PUBLIC_URL` |
| PoA-Sign                     | Mandant     | `PORTAL_PUBLIC_URL` |
| Staff-Reset-Link (zukünftig) | Mitarbeiter | Staff-Subdomain     |

Der aktuelle Code nutzt `PORTAL_PUBLIC_URL` für mandantengerichtete Links und
fällt nur im Single-Host-Setup auf `NEXTAUTH_URL` zurück.

### 4.1 n8n

n8n kann als lokaler Compose-Service laufen oder hinter einem eigenen VHost
stehen. Dabei vier Adressen getrennt behandeln:

| Adresse             | Beispiel                                     | Sichtbarkeit                                     |
| ------------------- | -------------------------------------------- | ------------------------------------------------ |
| Instanz-UI          | `https://n8n.kanzlei.example.de`             | Browserzugriff für berechtigte Workflow-Admins   |
| Management-API      | `http://n8n:5678/api/v1`                     | App → n8n; bevorzugt nur intern                  |
| Webhook-Präfix      | `http://n8n:5678/webhook`                    | nur technischer Präfix/Legacy                    |
| Exakte Workflow-URL | `http://n8n:5678/webhook/taxtronik-anfragen` | App/Worker → genau ein veröffentlichter Workflow |

Für neue Konfigurationen werden die exakten Production-URLs in TaxTronik pro
Workflow gespeichert. Der globale Wert ist nur ein Legacy-Fallback und bleibt
bei neuen Installationen leer:

```env
# Nur befristet für Outbound-Bestandsmigrationen:
N8N_WEBHOOK_BASE_URL=http://n8n:5678/webhook
# Globaler Callback-Migrationspfad bleibt standardmäßig unsichtbar:
N8N_LEGACY_CALLBACKS_ENABLED=false
# Pflicht, sobald die Legacy-URL oder das Callback-Flag aktiv ist (mind. 32 Zeichen):
N8N_HMAC_SECRET=<starkes zufälliges Secret>
```

Beim Import materialisiert TaxTronik das separat gespeicherte Feld
**TaxTronik-Adresse aus n8n** als App-Basis
(`__TAXTRONIK_API_URL__`) und die tenantgebundene Callback-Key-ID
(`__TAXTRONIK_CALLBACK_KEY_ID__`) automatisch in den ausgewählten
Workflow-Vorlagen. Die App-Basis muss aus dem n8n-Container erreichbar sein;
für den Betriebsmodus `BUNDLED` ist in Produktion `http://app:3000` der
Standard. Im lokalen Dev-Stack, in dem die App auf dem Host läuft, ist es
`http://host.docker.internal:3000`. Externe oder Cloud-Instanzen verwenden die
aus ihrer Laufzeit erreichbare Staff-/API-Subdomain. Das Feld ist bewusst
unabhängig von `NEXTAUTH_URL` und der n8n-Browser-URL. Neue n8n-Callbacks gehen
nur auf
`/api/integrations/n8n/v1/*` und verwenden das tenantgebundene
Callback-Credential aus Key-ID, Bearer-Token und minimalen Scopes. Die
Legacy-HMAC-Endpunkte `/api/n8n/*` antworten default-off mit `404`. Nur für eine
befristete Bestandsmigration dürfen sie mit
`N8N_LEGACY_CALLBACKS_ENABLED=true` und starkem HMAC-Secret aktiviert werden.
Beide Pfade gehören im Split-Setup auf die Staff/API-Seite, nicht auf das
öffentliche Mandantenportal.

Das Bearer-Token selbst gehört als
`Authorization: Bearer <token>` in ein n8n-Credential vom Typ
**Generic Header Auth**, nicht in Importfelder oder Workflow-JSON. Der
mitgelieferte Container blockiert `$env`-Zugriffe aus Nodes; die
Vorlagen benötigen auch keine editionsabhängigen `$vars` und bleiben
damit Community-kompatibel.

Die n8n-UI/API benötigt einen eigenen VHost; sie darf nicht unter der
Portal-Subdomain veröffentlicht werden. Für den Compose-Service setzt
`N8N_HOST=n8n.kanzlei.example.de` und
`N8N_WEBHOOK_URL=https://n8n.kanzlei.example.de/` die von n8n
angezeigte externe Webhook-Basis. Hinter einem Proxy zusätzlich die
vertrauenswürdigen Proxy-Hops und `X-Forwarded-For`,
`X-Forwarded-Host` sowie `X-Forwarded-Proto` korrekt
konfigurieren. Anleitung:
[n8n Webhook URL hinter Reverse Proxy](https://docs.n8n.io/hosting/configuration/configuration-examples/webhook-url/).

Wenn App und n8n dasselbe Compose-Netz nutzen, dürfen die in TaxTronik
gespeicherten Ziele die interne URL `http://n8n:5678/webhook/...`
verwenden, auch wenn n8n in der UI eine öffentliche Production-URL anzeigt.
Pfad und Workflow müssen identisch sein. Außerhalb eines isolierten internen
Netzes ist HTTPS Pflicht; HMAC verschlüsselt den Payload nicht.

Der optionale n8n-API-Key dient nur der Workflow-Verwaltung. Er ist weder das
Outbound-`N8N_HMAC_SECRET` noch das tenantgebundene Callback-Token.
API-Zugriff bevorzugt intern halten und auf minimale Workflow-Scopes
begrenzen.

### 5. Firewall (optional)

Bei einem Setup mit Staff-Surface nur intern:

```
staff.kanzlei.example.de   → nur aus 192.168.x.x erreichbar
portal.kanzlei.example.de  → öffentlich erreichbar (über Reverse-Proxy)
```

Realisierung am Reverse-Proxy oder in der Firewall — taxtronik selbst
hat keine IP-basierte Zugriffssteuerung (bewusst, weil das Reverse-Proxy-
Verantwortung ist).

## Single-Host-Fallback (Default)

Wenn keine Subdomain-Trennung gewünscht ist:

```env
NEXTAUTH_URL=https://taxtronik.kanzlei.example.de
# STAFF_COOKIE_DOMAIN und PORTAL_COOKIE_DOMAIN bleiben leer
```

Die path-basierte Trennung (`/staff/*` vs `/portal/*`) plus die getrennten
Cookie-Namen (`__Host-taxtronik_staff_session` vs
`__Host-taxtronik_portal_session`) mit `Path=/` bietet weiterhin saubere
Surface-Isolation, nur eben auf Cookie-Pfad-Ebene statt Subdomain-Ebene.

**Cookie-Präfix-Logik** (`apps/web/src/server/auth/session-cookie.ts`): In
Production ohne Cookie-Domain tragen die Session-Cookies das `__Host-`-Präfix
(Browser erzwingen Secure + `Path=/` + kein Domain-Attribut — kein
Überschreiben durch Subdomains). Mit gesetzter `STAFF_COOKIE_DOMAIN` /
`PORTAL_COOKIE_DOMAIN` (Subdomain-Trennung) heißen sie
`__Secure-taxtronik_*_session`, weil `__Host-` kein Domain-Attribut erlaubt.
Im Dev (HTTP) bleibt der unpräfixte Name `__taxtronik_*_session`.
