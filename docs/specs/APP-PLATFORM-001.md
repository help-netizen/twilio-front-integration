# APP-PLATFORM-001 — the conveniences a real author asks for (OB-54)

Status: spec for phase J; owner card OB-54. The small, unglamorous surfaces
that every serious app author reaches for once the big capabilities exist.
Depends on: APP-DATA-001, APP-EGRESS-001, APP-VIEW-001.

## 1. Four small things, one theme

None of these grant new power — they make the power already there usable. A
purchasing app needs the supplier's email to put in its table; a digest needs
to know which company it runs for; a builder debugging a draft needs to see
what its code decided; an event-driven app needs to know it was triggered by
an approval versus a schedule.

### 1.1 `ctx.company` — read-only identity

The isolate already receives `input.today`. It now also gets, in `ctx`:

```js
ctx.company // { name, timezone }  — frozen, no id, no PII
```

Composed by the CRM from the installation's company and passed like `today`.
No new tool call, no gateway round-trip. The company **id** is deliberately
absent — an app scopes nothing itself; the run token already binds it.

### 1.2 `input.trigger` — how this run started

Every run already knows its trigger inside the CRM (`manual`, `schedule`,
`action`, `event`). Surfacing it lets one app branch cleanly:

```js
ctx.input.trigger // "manual" | "schedule" | "action" | "event"
```

`action` and `event` already carry their detail (`input.action`,
`input.event`); this is the discriminator beside them.

### 1.3 Installation settings — a form the tenant fills, the app reads

A version declares up to **8 settings fields**:

```jsonc
{"settings": [
  {"key": "supplier_email", "label": "Supplier email", "type": "email", "required": true},
  {"key": "reorder_threshold", "label": "Reorder at qty", "type": "number"}
]}
```

Types: `text | number | email | url | boolean | select` (select carries
`options[]`). The CRM renders the form (view-document primitives, so no
app markup); the tenant fills it in the installation's settings; the app reads
the current values as **`ctx.settings`** — a frozen object, validated against
the declared schema, never carrying anything undeclared.

Storage: reuse `marketplace_installations.metadata` under an `app_settings`
key — no new table. Values are validated on write against the accepted
version's declaration; a URL field runs the same origin check the egress
connection does (a settings URL is not a bypass around egress — it is data,
never a call target). Secrets do **not** go here — those are APP-EGRESS-001,
write-only and encrypted; a settings field may not be typed `secret`.

### 1.4 `ctx.log` — the author's debugging window

```js
ctx.log(message) // string, ≤ 500 chars, ≤ 50 lines per run
```

Lines are collected by the runner and returned in the run report (dry run)
and stored with the run (live), visible only to the app's own author/admin in
run history — never to the app's users, never in a view document. Over the
line cap, further calls are dropped with a single "log truncated" marker.
`ctx.log` is a no-op sink for values it cannot stringify; it never throws.

## 2. What this is not

No new migration for §1.1/1.2/1.4 — they ride the existing input path and the
run record. §1.3 reuses installation metadata. No new permission. No egress,
no writes, no data — this phase adds vocabulary, not reach.

## 3. Verification contract

1. `ctx.company` is `{name, timezone}`, frozen, no id; an app reading
   `ctx.company.id` gets undefined.
2. `input.trigger` matches the trigger for each of the four run kinds.
3. Settings: declared schema validated (undeclared key refused, wrong type
   refused, required-missing refused on the settings write); `ctx.settings`
   carries only declared keys; a `url` field rejects a private origin; `secret`
   type refused at declaration.
4. `ctx.log`: lines appear in the dry-run report and the live run record;
   the 50-line cap truncates with a marker; a non-stringifiable argument is a
   no-op, not a throw; logs never appear in the view document returned to a user.
5. Settings live-gated read (phase A viewer gate) and tenant-admin write;
   T-blast across companies; uninstall drops them with the installation.
6. Sabotage: let an undeclared settings key reach `ctx.settings` → red; restore.
