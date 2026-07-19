# SETTINGS-IA-001 — Settings information architecture

Status: implemented; Batch 1 and Batch 2 completed 2026-07-18. Owner amendments locked 2026-07-18.

## Goal

Replace the flat Settings navigation with an intent-based hierarchy. Settings has eight tenant groups, each group reveals its subsections only while that group is active, and platform administration remains visually and authorization-wise separate. Existing leaf URLs remain valid.

This is an information-architecture change. It does not grant new permissions. Batch 2 places the existing telephony surfaces under the shared Settings shell and folds the legacy Providers information into Technicians without changing either data source's authorization.

## Approved tenant structure

| Group | Subsections | Canonical route / address |
|---|---|---|
| **Business** | Business profile | `/settings/company` |
| **Scheduling & service areas** | Company schedule; Service areas; Technicians | `/settings/scheduling/company-schedule`; `/settings/service-territories`; `/settings/technicians` |
| **Jobs** | Job setup; Job workflows; Automations; Job list columns | `/settings/lead-form?tab=settings`; `/settings/lead-form?tab=workflows`; `/settings/automation`; `/settings/jobs/list-columns` |
| **Phone & AI** | Phone system; Phone setup; AI phone agent; Email assistant; Outbound lead caller; Message templates | `/settings/telephony`; `/settings/integrations/telephony-twilio`; `/settings/integrations/vapi-ai`; `/settings/integrations/mail-secretary`; `/settings/integrations/outbound-lead-caller`; `/settings/quick-messages` |
| **Billing & payments** | Albusto plan & usage; Customer payments (Stripe); Bank transfer details; Price book; Document templates | `/settings/billing`; `/settings/integrations/stripe-payments`; `/settings/billing/bank-transfer-details`; `/settings/price-book`; `/settings/document-templates` |
| **Apps & integrations** | Marketplace; Zenbooker; Google Email; API access | `/settings/integrations?tab=marketplace`; `/settings/integrations?tab=zenbooker`; `/settings/integrations/google-email`; `/settings/integrations?tab=api-keys` |
| **Team & access** | Users; Roles & permissions | `/settings/users`; `/settings/roles` |
| **Alerts & notifications** | Alerts & notifications | `/settings/actions-notifications` |

After the tenant groups, a role-gated **Platform administration** divider/group contains Super admin. It is visible only to `super_admin`, exactly as before.

### Implementation status

- Batch 1 introduced the shared navigation model, eight groups, Company schedule, addressable tabs, and route compatibility.
- Batch 2 removes the temporary Providers leaf, redirects its URL to Technicians, and moves the regular telephony pages from the second telephony sidebar into the shared Settings layout.

## Navigation behavior

1. One typed group-to-subsection model is the source of truth for the persistent desktop Settings sidebar and the header/mobile Settings menu.
2. The desktop sidebar always shows the visible top-level groups. Only the active group reveals its visible subsections.
3. The header/mobile menu uses the same filtered model. Outside Settings it shows the visible groups; while a Settings group is active it also reveals that group's subsections.
4. Permission arrays retain `ProtectedRoute` any-of semantics. A group is hidden if it has no visible subsection. The document-templates entry intentionally retains `tenant.integrations.manage`.
5. `/settings` resolves to the first visible subsection in approved group order. Each group landing route does the same within its group and falls back to the first visible Settings subsection if that group is unavailable.
6. Platform administration is separated visually and remains gated by platform role rather than tenant capability.

Group landing routes are:

- `/settings/business`
- `/settings/scheduling`
- `/settings/jobs`
- `/settings/phone-ai`
- `/settings/billing-payments`
- `/settings/apps-integrations`
- `/settings/team-access`
- `/settings/alerts-notifications`
- `/settings/platform-administration` (role-gated content resolution)

## Company schedule move

- The schedule gear and the mobile dispatch Settings action deep-link to `/settings/scheduling/company-schedule`; they no longer open an overlay.
- The route shell accepts `schedule.dispatch` or `tenant.company.manage` because it now hosts two previously distinct capabilities. The company-hours section and `/api/schedule/settings` request remain gated by `schedule.dispatch`.
- The form edits timezone, distance unit, company work hours/days, and slot duration through `GET/PATCH /api/schedule/settings`.
- `RecommendationSettings` is embedded on the Company schedule page. It is not a separate navigation subsection and is removed from the Technicians page.
- Recommendation controls remain visible only with `tenant.company.manage`, matching their existing API guard; a dispatch-only user still sees and edits the company working week without receiving a newly granted capability.
- Time off remains on `/schedule` and keeps its existing panel and permissions.

## Route compatibility and addressable tabs

- Every pre-existing leaf URL continues to render the same surface; regrouping changes discoverability, not authorization or API behavior.
- `/settings/action-required` and `/settings/email` retain their existing redirects.
- The Integrations tabs are controlled by `?tab=marketplace|api-keys|zenbooker`. Missing or invalid values resolve to Marketplace. Tab changes preserve unrelated search parameters.
- Lead/job tabs are controlled by `?tab=settings|workflows`; the existing `/settings/lead-form` URL still opens Job setup.
- Full-screen API documentation remains `/settings/api-docs`; API access links to it from the addressable API-access tab.
- Contextual back links return to their new intent group or tab instead of assuming `/settings/integrations` is the Settings home.
- `/settings/providers` redirects to `/settings/technicians`; the target retains the existing `tenant.company.manage` guard.

## Telephony consolidation and technician merge

- The regular `/settings/telephony`, `/settings/telephony/user-groups`, `/settings/telephony/user-groups/:groupId`, `/settings/telephony/phone-numbers`, `/settings/telephony/audio-library`, `/settings/telephony/blacklist`, `/settings/telephony/provider-settings`, `/settings/telephony/routing-logs`, and `/settings/telephony/dashboard` surfaces render under `SettingsLayout`.
- `TelephonyLayout` retains the existing `/api/telephony/numbers/status` connection gate and fail-open behavior, but no longer owns a second sidebar, viewport height, or content scroller. The shared Settings shell owns navigation and scrolling.
- `/settings/telephony/user-groups/:groupId/flow` remains a full-screen builder outside `SettingsLayout`. Its route prefix maps it contextually to the Phone system subsection, and its back action returns to User Groups.
- All telephony URLs and `/calls/dashboard` remain valid. All regular telephony routes retain `tenant.telephony.manage`.
- Technicians remains the canonical active roster and schedule/service-area surface. `GET /api/settings/technicians` includes the legacy Providers surface's avatar, status, phone, email, skill tags, assigned territories, and calendar color from its existing tenant-scoped Zenbooker roster read.
- The canonical endpoint performs one roster read; the frontend does not issue a second `/api/zenbooker/team-members` request. No fallback invents or substitutes roster data.

## Authorization matrix (unchanged)

| Surface | Existing guard retained |
|---|---|
| Company schedule working week | `schedule.dispatch` |
| Company schedule recommendations | `tenant.company.manage` |
| Business profile, Service areas, Technicians, Job setup/workflows, Automations, Job list columns, Bank transfer details, Alerts & notifications | `tenant.company.manage` |
| Phone system | `tenant.telephony.manage` |
| Phone setup, AI apps, Customer payments, Marketplace/Zenbooker/Google Email/API access, Document templates | `tenant.integrations.manage` |
| Price book | `price_book.manage` |
| Users | `tenant.users.manage` |
| Roles & permissions | `tenant.roles.manage` |
| Platform administration | platform role `super_admin` |

The unusual Customer payments and Document templates guards are deliberate compatibility constraints, not an endorsement of their current permission taxonomy.

## Batch plan

### Batch 1

- Shared filtered navigation model and active-link matching.
- Eight-group desktop and header/mobile navigation.
- Dynamic Settings and group landing redirects.
- Company schedule page, extracted dispatch form, recommendation controls move, and Schedule deep link.
- Route-addressable Integrations and lead/job tabs.
- Bank transfer and job-list-column subsections without API or permission changes.
- Back-link audit, approved user-facing renames, and `BLANC API` → `Albusto API` copy fix.
- Focused navigation, redirect, addressability, and Company schedule tests.

### Batch 2 (implemented after owner gate)

- Consolidated all regular telephony routes into the shared Settings layout while retaining the connection gate and full-screen call-flow builder.
- Merged the legacy Providers contact/skill/territory/profile visibility into Technicians and added the approved compatibility redirect.
- Added route/layout smoke coverage for every telephony page, parent-subsection matching, the Providers redirect, and technician roster enrichment.

## Risks

- A subsection can live in a group whose permission differs from adjacent subsections. The shared model and leaf `ProtectedRoute` must stay synchronized.
- Query-addressed tabs need explicit active matching; pathname prefix matching alone would highlight several subsections at once.
- Links into full-screen Settings surfaces do not render the Settings sidebar. Their contextual back links are therefore part of the IA contract.
- The optional detailed-roster mode is reserved for the tenant-company-managed Technicians route. Operational roster consumers continue receiving the minimal `{ id, name, active }` shape.

## Acceptance

- Exactly eight tenant top-level groups render for a fully authorized tenant user, plus the separate platform group only for `super_admin`.
- Permission filtering hides inaccessible subsections and empty groups.
- `/settings` and every group landing resolve deterministically to the first visible authorized leaf.
- Old leaf URLs still work.
- The Schedule gear navigates to Company schedule; Time off remains on Schedule.
- Company schedule loads/saves through `/api/schedule/settings` and visibly contains Recommendation settings.
- Integrations tabs can be linked and refreshed independently.
- Every regular telephony page renders under the unified Settings navigation; the call-flow builder stays full-screen and maps to Phone system.
- `/settings/providers` redirects to `/settings/technicians`, and no Providers navigation leaf remains.
- Technician cards retain the legacy Providers page's Zenbooker profile, contact, skill, and territory visibility.
- Frontend production build and the complete frontend Vitest suite pass.
