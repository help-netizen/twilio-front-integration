# TENANCY-RBAC-CANON — design gate

Step 1 lint catches mechanical violations; this gate catches missing tenant/RBAC design.

## Mandatory spec block (copy, fill, reject if empty/missing)

```md
## Tenancy & Roles
| surface (route/worker/webhook/SSE/aggregate) | scoped by | key used | permission | roles ✓/✗ | blast-radius risk |
|---|---|---|---|---|---|
| `<METHOD /path or worker>` | `<company source>` | `<id/natural key>` | `<catalog key>` | `<role ✓; role ✗>` | `<shared-key/action risk>` |
```

## Mandatory test contract (each company-scoped surface)

- [ ] `T-own`: own company → works.
- [ ] `T-foreign`: foreign id → 404, never 403; no side effect; writes leave the foreign row byte-unchanged.
- [ ] `T-blast`: seed A+B with the same phone/email/external id; act in A; B rows stay untouched. An id-only test cannot catch this.
- [ ] `R-matrix`: one test per DENY cell, plus the allow path.
- [ ] Sabotage: remove the tenant guard → this suite MUST go red.

```js
it('T-blast: shared natural key cannot cross companies', async () => {
  await seed(A, { phone: SHARED });
  const b = await seed(B, { phone: SHARED });
  const beforeB = await rawSnapshot(B, b.id);
  await actAs(A, { phone: SHARED });
  expect(await rawSnapshot(B, b.id)).toStrictEqual(beforeB);
});
```

## Dangerous-surface registry

- Workers/cron: no `req` means no `companyFilter`; take `companyId` explicitly.
- Webhooks: resolve external id → `company_id` first, then scope all work; never trust event metadata (Stripe account→company rule).
- Natural keys: phone/email/SID are not tenant-unique (real: outbound phone cancel crossed tenants).
- Aggregates/counts/badges: scope the base query and pagination (real: Pulse pagination leaked SMS).
- SSE/realtime: filter every subscription/event by company.
- Shared external API keys: bind credentials to company (real: Zenbooker default-company leak).
- MCP/agent tools: a tool call is an API call; 21/64 audit RBAC gaps were tool endpoints.

Audit/baseline: `TENANCY-RBAC-AUDIT-001.md`. Mechanical rules remain in the tenant-safety lint.
