# infra/ — production reverse-proxy config (reference copies)

These are **reference copies** of infrastructure config that lives on the prod
host (Vultr `deploy@108.61.87.117`). The files on the box are authoritative —
this directory exists so the config is version-controlled and reviewable, not
because anything reads it at deploy time. The app release pipeline (`rsync` into
`/opt/albusto/app` → `docker compose build`) does **not** touch `/etc/caddy`.

## Caddyfile

Live path on the box: `/etc/caddy/Caddyfile` (Caddy 2.6.2, systemd service `caddy`).
Fronts three sites: `albusto.com` (static), `app`/`api.albusto.com` → app `:3000`
(+ `/apps/leads*` → `:4001`), and `auth.albusto.com` → Keycloak `:8081`.

### Applying a change (validate → backup → swap → reload)

`/etc/caddy/` is **root-owned**, so creating a backup / new file there needs `sudo`
(the `Caddyfile` itself is `deploy`-owned, but a *new* file in that dir is not).

```sh
# 1. write the new config to a temp path, then validate it
caddy validate --adapter caddyfile --config /tmp/Caddyfile.new
# 2. back up + swap (sudo — root owns the dir)
sudo cp -p /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%Y%m%d-%H%M%S)
sudo cp /tmp/Caddyfile.new /etc/caddy/Caddyfile
# 3. graceful reload (no dropped connections; refuses an invalid config)
sudo systemctl reload caddy
```

Rollback: `sudo cp /etc/caddy/Caddyfile.bak.<ts> /etc/caddy/Caddyfile && sudo systemctl reload caddy`.

### auth.albusto.com root redirect (KC-ROOT-BRAND-001)

The bare root would otherwise `302` into Keycloak's raw Administration Console.
An **exact** `path /` matcher redirects only the root to the app; the login flow
(`/realms/*`), OIDC discovery, `/resources/*`, and the admin console (`/admin`,
login-gated) are all untouched.
