# Спецификация: RF008 — Telephony Admin Isolation Audit

**Дата:** 2026-03-24
**Статус:** Done (no changes needed)
**Зависит от:** RF003 (done)

---

## Scope

Проверить, что telephony admin flows используют те же transport/state conventions, что и остальной frontend/backend.

## Findings

### Frontend: 17 telephony pages
All located in `frontend/src/pages/telephony/`:
- `CallFlowBuilderPage`, `CallFlowsPage`, `PhoneNumbersPage`, `UserGroupsPage`, `UserGroupDetailPage`, `PhoneNumberGroupsPage`, `PhoneNumberGroupDetailPage`, `SchedulesPage`, `ScheduleDetailPage`, `ProviderSettingsPage`, `AudioLibraryPage`, `RouteManagerOverviewPage`, `OperationsDashboardPage`, `RoutingLogsPage`, `ActiveCallWorkspacePage`, `nodeDefaults.ts`, `nodeInspectors.tsx`

### Transport audit
- ✅ **No raw `fetch()`** — all telephony pages use `authedFetch` from `services/apiClient.ts`
- ✅ Verified via grep: zero hits for `raw fetch(` pattern
- ✅ `UserGroupsPage` has 6 `authedFetch` calls — canonical transport

### Backend routes
- `callFlows.js`, `userGroups.js`, `phoneNumbers.js`, `vapi.js` — all use `db` directly (as documented in RF005 Slice 7: Settings/Admin)
- This is acceptable — settings routes have simple CRUD semantics that don't warrant a service layer

## Conclusion

**No changes required.** Telephony admin flows are already compliant with frontend transport conventions (RF003). Backend route patterns follow the same direct-db pattern as other settings routes.
