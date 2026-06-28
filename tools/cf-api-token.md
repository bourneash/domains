# Cloudflare API Token Spec

Single consolidated account token for all fleet automation. Create at:
**dash.cloudflare.com/profile/api-tokens → Create Token → Custom token**

Name it something like `domains-fleet` or `domains-ops`.

After creating, update `CLOUDFLARE_API_TOKEN=` in `/home/jesse/projects/domains/.env`.

---

## Account permissions

Scope: **Jessetamburino@hotmail.com's Account**

| Permission | Level |
|---|---|
| Workers CI | Write |
| Workers Scripts | Write |
| Workers Scripts | Read |
| Workers KV Storage | Write |
| Workers KV Storage | Read |
| Workers R2 Storage | Write |
| Workers R2 Storage | Read |
| Workers Observability | Write |
| Workers Observability | Read |
| Workers Tail | Read |
| Secrets Store | Write |
| Pages | Write |
| D1 | Write |
| D1 | Read |
| Account Analytics | Read |
| Account Settings | Read |
| Account Settings | Write |
| Email Routing Addresses | Write |
| Email Routing Addresses | Read |
| Email Routing Suppressions | Write |
| Email Routing Suppressions | Read |
| Email Sending | Write |
| Email Sending | Read |
| Notifications | Read |

### Intentionally excluded from Jesse's list
These were in the reviewed set but are not needed for fleet ops:

| Permission | Why excluded |
|---|---|
| Account API Tokens Write | Can mint new tokens — too broad, keep Read-only or drop |
| Registrar Domains Admin/Read | We use external registrars, not CF Registrar |
| Load Balancers / Monitors and Pools | Not used |
| Zero Trust / Access | Not used |
| Page Shield | Not used |
| Account WAF | Not used |
| DDoS Protection / Botnet Feed | Not used |
| DNS Firewall | Not used |
| URL Scanner | Not used |
| Logs Write/Read | No Logpush configured |
| Realtime Admin | Not used |
| Cloud Email Security | Not used |
| Billing Read | Not needed for automation |
| Workers Containers | Not used yet |
| Workers Pipelines | Not used yet |
| Browser Rendering | Not used yet |
| Websearch Run | Not used |
| Account Firewall Access Rules | Not used |
| Account Security Center | Not used |

Add any of the excluded permissions back if a new tool requires them.

---

## Zone permissions

Scope: **All zones**

| Permission | Level |
|---|---|
| Zone | Read |
| DNS | Edit |
| Workers Routes | Edit |
| Zone Settings | Edit |
| SSL and Certificates | Edit |
| Analytics | Read |
| Email Routing Rules | Edit |

---

## User permissions

| Permission | Level |
|---|---|
| Memberships | Read |
| User Details | Read |

---

## What each permission group covers

| Group | Used for |
|---|---|
| Workers CI / Scripts | Deploy Workers, manage build pipeline env vars |
| Workers KV / R2 / D1 | Storage bindings for Workers |
| Workers Observability / Tail | Log streaming from Workers |
| Secrets Store | Worker secrets management |
| Pages | CF Pages build pipeline (some sites still use it) |
| Email Routing | Setting up `contact@<domain>` forwarding per site |
| Zone DNS | DNS record management (TXT, CNAME, A, MX) across all 30+ zones |
| Workers Routes | Binding worker routes to specific zones |
| Zone Settings / SSL | Zone-level config, cert management |
| Account Analytics | Fleet-level analytics reads |
