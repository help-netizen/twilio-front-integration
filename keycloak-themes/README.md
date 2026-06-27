# Keycloak themes

## `albusto` — branded login theme

A custom Keycloak **login** theme that renders an Albusto-branded page while
Keycloak still performs the credential check and session handling underneath.

Two-column shell (`login/template.ftl` → `registrationLayout`):

- **Left** — the real Keycloak form (`login/login.ftl`): username/password,
  field errors, Remember me, Forgot password, password-visibility toggle, and a
  "Create an account" link to the SPA self-registration page (`signupUrl` in
  `theme.properties`). Every other login-theme page (reset password, OTP, update
  password) inherits the same shell automatically.
- **Right** — "Shipped recently": a scrollable deploy history auto-generated
  from `git log` into `login/history.ftl` (date + the commit that shipped),
  hidden on mobile.

Styling is the Blanc design system (`login/resources/css/albusto-login.css`):
near-white surface, floating labels, `--blanc-job` primary blue.

### Regenerating the "Shipped recently" feed

`login/history.ftl` is generated — do not hand-edit it. Rebuild it from git
history (the prod box has no `.git`, so run this locally before deploying):

```
npm run gen:login-history    # → node scripts/gen-login-history.mjs
```

It keeps user-facing commits (feat / fix / perf / redesign / polish …), drops
chore/docs/test/ci/build/merge noise, strips conventional-commit prefixes and
leading/trailing ticket codes, and wraps the include in `<#noparse>` so a stray
`${` or `<#` in a commit message can never break template rendering.

### Login vs. the SPA signup page

The login theme (here) and the React self-registration page
(`frontend/src/pages/auth/SignupPage.tsx` + `auth-shell.css`) share the same
two-column Blanc shell but **intentionally differ on the right**: login shows
the deploy history, signup shows the static "Why Albusto" benefits. They run in
different runtimes (Keycloak FreeMarker vs Vite/React) and can't share a
stylesheet, so if you change the shared shell (brand, fields, colors) update
both.

### Wiring

- **Local dev** (`docker-compose.auth.yml`): the theme is mounted at
  `/opt/keycloak/themes` and the realm sets `"loginTheme": "albusto"`
  (`keycloak/realm-export.json`). `start-dev` does not cache themes, so edits
  show on reload.
- **Production**: mount `keycloak-themes/` into the Keycloak container, set the
  realm's login theme (`kcadm update realms/crm-prod -s loginTheme=albusto`) and
  restart Keycloak (production mode caches themes). See the deploy memory
  `prod-deploy-procedure` for the exact steps.

### Notes

- Fonts load from Google Fonts with a system fallback; if a strict CSP blocks
  them the page degrades gracefully to system fonts.
- After a CSS change in production, bump `version=` in `theme.properties` (or
  rely on the forced logout) to avoid stale cached resources.
- Verified on Keycloak 24 and 26 (no version-specific FTL features used).
