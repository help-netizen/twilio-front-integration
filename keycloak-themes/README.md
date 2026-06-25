# Keycloak themes

## `albusto` — branded login theme

A custom Keycloak **login** theme that renders an Albusto-branded page while
Keycloak still performs the credential check and session handling underneath.

Two-column shell (`login/template.ftl` → `registrationLayout`):

- **Left** — the real Keycloak form (`login/login.ftl`): username/password,
  field errors, Remember me, Forgot password, password-visibility toggle.
  Every other login-theme page (reset password, OTP, update password) inherits
  the same shell automatically.
- **Right** — "Shipped recently": a scrollable deploy history, **auto-generated
  from git** into `login/history.ftl`.

Styling is the Blanc design system (`login/resources/css/albusto-login.css`):
near-white surface, floating labels, `--blanc-job` primary blue.

### Refresh the deploy history

`login/history.ftl` is generated — never edit it by hand. Regenerate from the
current git log before each deploy:

```bash
npm run gen:login-history     # → keycloak-themes/albusto/login/history.ftl
```

Only user-facing commits are kept (feat / fix / perf / redesign / polish …);
chore/docs/test/ci/build/merge are dropped, conventional-commit prefixes and
internal ticket codes are stripped, and the file is wrapped in `<#noparse>` so a
stray `${` in a commit message can never break rendering.

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
