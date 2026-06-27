# AUTH-SESSION-001 — keep users logged in on mobile (30-day Remember Me)

Status: PLANNED (orchestrate, 2026-06-27). Owner-reported prod UX.

## Problem
Mobile browser logs the user out after ~5 min of backgrounding. Root cause: `rememberMe=false` on the
`crm-prod` realm → Keycloak's SSO identity cookie is a **session cookie** (non-persistent). Mobile browsers
discard backgrounded tabs; on return the page cold-reloads, the cookie is gone, and `AuthProvider`
(`kc.init onLoad:'login-required'`) finds no session → redirect to login. Sessions are also short:
`ssoSessionIdleTimeout=1800` (30 min), `ssoSessionMaxLifespan=36000` (10 h). `accessTokenLifespan=300`
(5 min) is the symptom timing but is correct (refreshed transparently).

## Decisions (owner)
- D1: session lifetime = **30 days**.
- D2: **Remember Me enabled + default-ON** (persistent cookie + long timeouts automatically, no checkbox hunt).
- D3: frontend refreshes the token on **tab resume** (visibilitychange/focus).
- Keep `accessTokenLifespan=300`. Security tradeoff (lost device stays logged in 30 days) — accepted.

## Tasks
| ID | Area | Change |
|----|------|--------|
| T1 | Keycloak realm (prod) | kcadm `update realms/crm-prod`: `rememberMe=true`, `ssoSessionIdleTimeoutRememberMe=2592000`, `ssoSessionMaxLifespanRememberMe=2592000` (30d). Instant, no deploy. |
| T2 | Realm export | `keycloak/realm-export.json`: mirror T1 so fresh/dev imports keep it. |
| T3 | Login theme | `keycloak-themes/albusto/login/login.ftl`: the Remember Me checkbox is **default-checked**. (theme rsync + KC `--force-recreate`) |
| T4 | Frontend | `frontend/src/auth/AuthProvider.tsx`: on `visibilitychange`/`focus` (tab visible + authenticated) → `kc.updateToken()`; best-effort, cleanup on unmount. (app rebuild) |
| T5 | deploy | kcadm (T1) + theme force-recreate (T3) + frontend rebuild (T4). One fresh login needed to mint the persistent cookie. |

## Verify
Prod realm shows `rememberMe:true` + 30d remember-me timeouts; login page renders a **checked** "Remember me";
frontend build green; after one login the KEYCLOAK_IDENTITY cookie is persistent (has Max-Age, survives a
mobile background/restart).
