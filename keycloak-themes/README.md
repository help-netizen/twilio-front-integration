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
- **Right** — a static "Why Albusto" benefits block (hidden on mobile).

Styling is the Blanc design system (`login/resources/css/albusto-login.css`):
near-white surface, floating labels, `--blanc-job` primary blue.

### Keep it consistent with the SPA signup page

The React self-registration page (`frontend/src/pages/auth/SignupPage.tsx` +
`auth-shell.css`) intentionally mirrors this theme — same two-column shell, same
"Why Albusto" benefits. If you change the benefits copy or the shell here,
update the SPA file too (and vice-versa); the two run in different runtimes
(Keycloak FreeMarker vs Vite/React) and can't share a stylesheet.

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
