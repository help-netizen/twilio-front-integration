---
description: how to analyze error logs and fix production bugs one by one
---

# Analyze & Fix Production Errors

This workflow reads `logs/errors.json` (captured by `fly-error-monitor.js`) and fixes each error one at a time.

## Prerequisites

Make sure the error monitor has been running and `logs/errors.json` exists:
```bash
npm run monitor:errors    # run for a while, then Ctrl+C
```

## Steps

### 1. Review captured errors
// turbo
```bash
npm run monitor:replay
```

### 2. Pick the first unfixed error

Read `logs/errors.json` and identify the **first** error entry. Note:
- `errorLine` — the actual error message
- `category` — type of error (database, runtime, network, http, auth)
- `source` — which module produced it (e.g. ZbWebhook, Jobs API)
- `context` — surrounding log lines for diagnosis
- `timestamp` — when it occurred

### 3. Diagnose the root cause

Based on `category`:

| Category | Where to look |
|----------|---------------|
| `database` | Check `backend/db/migrations/` for missing columns/tables. Check `backend/src/services/` and `backend/src/db/queries.js` for the SQL query that failed. |
| `runtime` | Search for the function name from the stack trace in `backend/src/`. Check for null/undefined access patterns. |
| `network` | Check external service connectivity (Twilio, Zenbooker). Look at `backend/src/services/` for the API call. |
| `http` | Check the route handler in `backend/src/routes/`. Look at the HTTP status code (500/502/503). |
| `auth` | Check Keycloak config, JWT expiry, and `backend/src/middleware/keycloakAuth.js`. |
| `memory` | Check for memory leaks, large data processing, or missing pagination. |

### 4. Fix the bug

Apply the fix locally:
- **Database schema issue** → create a new migration in `backend/db/migrations/` and apply to production via:
  ```bash
  flyctl ssh console -a abc-metrics -C "node -e \"const {Pool}=require('pg'); const p=new Pool({connectionString:process.env.DATABASE_URL}); p.query('<YOUR SQL HERE>').then(r=>{console.log('✅ Done', JSON.stringify(r.rows||[]));p.end()}).catch(e=>{console.error('❌',e.message);p.end()})\""
  ```
- **Code bug** → fix the file in `backend/src/`, test locally with `npm run dev`
- **Config issue** → update Fly.io secrets: `flyctl secrets set KEY=VALUE -a abc-metrics`

### 5. Deploy the fix (if code was changed)

```bash
npm run deploy:prod
```

### 6. Verify the fix

Run the monitor again and confirm the error no longer appears:
// turbo
```bash
rm logs/errors.json && npm run monitor:errors
```
Wait ~30 seconds, then Ctrl+C and check:
// turbo
```bash
npm run monitor:replay
```

### 7. Repeat

Go back to **Step 2** and pick the next error. Continue until `logs/errors.json` shows zero errors for a sustained period.
