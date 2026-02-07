---
project: "Twilio Call Viewer"
version: "0.1.0"
status: "Phase 1 Complete"
last_updated: "2026-02-04 02:15"
maintainer_requirement: "This document MUST be kept up-to-date after any environment, deployment, or feature changes"
---

# Twilio Call Viewer - Project Environment & Configuration

> ⚠️ **IMPORTANT:** This document must be updated whenever:
> - New environment variables are added
> - Deployment procedures change
> - New services/APIs are integrated
> - Features are implemented or modified
> - Access credentials are rotated
> - Server configuration changes

## 📋 Project Overview

**Purpose:** Standalone web application for viewing Twilio call history with Front-inspired UI

**Architecture:**
- **Frontend:** React + TypeScript (Vite dev server)
- **Backend:** Node.js + Express API
- **Database:** PostgreSQL (planned for Phase 2)
- **External Services:** Twilio API

**Current Phase:** Phase 1 - Frontend & Infrastructure Complete

---

## 🌍 Environment Configuration

### Development Environment

**Location:** `/Users/rgareev91/contact_center/twilio-front-integration`

**Node Version:** v25.2.1  
**NPM Version:** 11.6.2

### Environment Files

#### Backend `.env`
Location: `/Users/rgareev91/contact_center/twilio-front-integration/.env`

**Required Variables:**
```bash
# Front App Credentials
FRONT_APP_UID=your_app_uid_here
FRONT_APP_SECRET=your_app_secret_here

# Twilio Credentials
TWILIO_ACCOUNT_SID=ACxxxxx
TWILIO_AUTH_TOKEN=xxxxx

# Server Configuration
PORT=3000
NODE_ENV=development

# Database (Phase 2)
DATABASE_URL=postgresql://user:password@localhost:5432/twilio_calls

# Webhooks
CALLBACK_HOSTNAME=https://your-server.com
FRONT_WEBHOOK_SECRET=your_webhook_secret
TWILIO_WEBHOOK_SECRET=your_twilio_webhook_secret
```

**Template:** `.env.example` (committed to Git, safe to share)

#### Frontend `.env`
Location: `/Users/rgareev91/contact_center/twilio-front-integration/frontend/.env`

**Required Variables:**
```bash
VITE_API_URL=/api
```

---

## 🔑 API Keys & Access Credentials

### Twilio

**Service:** Phone call API and webhooks  
**Documentation:** https://www.twilio.com/docs/usage/api

**Required Credentials:**
- `TWILIO_ACCOUNT_SID` - Account identifier
- `TWILIO_AUTH_TOKEN` - Authentication token

**Where to Get:**
1. Login to Twilio Console: https://console.twilio.com
2. Navigate to Account → API Keys & Tokens
3. Copy Account SID and Auth Token

**Webhook Signature:**
- Used for: Verifying webhook authenticity
- Algorithm: HMAC-SHA1
- Variable: `TWILIO_WEBHOOK_SECRET`

### Front App (Future Integration)

**Service:** Front Channel API  
**Documentation:** https://dev.frontapp.com/docs

**Required Credentials:**
- `FRONT_APP_UID` - Application unique identifier
- `FRONT_APP_SECRET` - Application secret for JWT signing

**Where to Get:**
1. Login to Front Developer Portal: https://dev.frontapp.com
2. Create new Application Channel
3. Copy App UID and App Secret

**Authentication:**
- Method: JWT (HS256 algorithm)
- Token expiration: 300 seconds (5 minutes)
- Claims required: `iss`, `jti`, `sub`, `exp`

### PostgreSQL Database (Phase 2)

**Service:** Primary data storage  
**Documentation:** https://www.postgresql.org/docs/

**Connection String Format:**
```
postgresql://username:password@host:port/database
```

**Where to Get:**
- Local development: Install PostgreSQL locally
- Production: Use managed service (AWS RDS, Heroku Postgres, etc.)

**Tables (Planned):**
- `contacts` - Phone numbers and contact info
- `conversations` - Call threads grouped by phone number
- `messages` - Individual call records

---

## 🚀 Server Management

### Starting Services

#### Backend Server
```bash
cd /Users/rgareev91/contact_center/twilio-front-integration

# Development mode (with auto-reload)
npm run dev

# Production mode
npm start

# Run tests
npm test
```

**Port:** 3000  
**Access:** http://localhost:3000  
**Health Check:** http://localhost:3000/health  
**SSE Debug:** http://localhost:3001/sse-debug.html (when frontend is running)

**Services Running:**
- Express API server
- SSE real-time events endpoint (`/events/calls`)
- Inbox worker (polls `twilio_webhook_inbox` table every 1s)

#### Frontend Development Server
```bash
cd /Users/rgareev91/contact_center/twilio-front-integration/frontend

# Start Vite dev server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

**Port:** 3001  
**Access:** http://localhost:3001  
**API Proxy:** `/api` → `http://localhost:3000`

### Stopping Services

```bash
# If running in foreground: Ctrl+C

# If running in background:
# Find process
lsof -i :3000  # Backend
lsof -i :3001  # Frontend

# Kill process
kill -9 <PID>
```

### Restarting Environment

#### Full Restart (Clean State)
```bash
# 1. Stop all services
# Press Ctrl+C in terminal windows

# 2. Clear node_modules (if needed)
rm -rf node_modules frontend/node_modules
rm -rf package-lock.json frontend/package-lock.json

# 3. Reinstall dependencies
npm install
cd frontend && npm install && cd ..

# 4. Restart services
npm run dev          # Backend (terminal 1)
cd frontend && npm run dev  # Frontend (terminal 2)
```

#### Quick Restart
```bash
# Just restart processes (Ctrl+C and re-run commands)
npm run dev          # Backend (includes inbox worker)
cd frontend && npm run dev  # Frontend
```

**Note:** The inbox worker runs automatically within the backend server process. No separate worker process is needed.

### Verifying Services

```bash
# Check backend
curl http://localhost:3000/health
# Should return: {"status":"ok","timestamp":"..."}

# Check frontend
curl http://localhost:3001
# Should return: HTML page

# Check API proxy
curl http://localhost:3001/api/conversations
# Should proxy to backend
```

---

## 📦 External Services & APIs

### 1. Twilio API

**Purpose:** Fetch call history and receive webhooks  
**Documentation:** https://www.twilio.com/docs/voice/api  
**Status:** Configured, not yet integrated with sync service

**Endpoints Used:**
- `GET /2010-04-01/Accounts/{AccountSid}/Calls.json` - List calls
- `GET /2010-04-01/Accounts/{AccountSid}/Calls/{CallSid}.json` - Get call details

**Webhooks Received:**
- `POST /webhooks/twilio/status` - Call status updates
- `POST /webhooks/twilio/incoming` - Incoming call events

**Rate Limits:**
- Default: 100 requests/second
- Calls API: No strict limit, but use pagination

**SDK:**
```javascript
const twilio = require('twilio');
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
```

#### Twilio CLI

**Installation:** Already installed globally  
**Version:** 6.2.3  
**Documentation:** https://twil.io/cli

**Setup & Authentication:**

```bash
# Login (one-time setup)
twilio login
# Enter Account SID and Auth Token from console
# CLI creates API Key for future access

# View available profiles
twilio profiles:list

# Set active profile
twilio profiles:use twilio-calls

# Current setup:
# - Profile: twilio-calls
# - API Key: SK... (see ~/.twilio-cli/config.json)
# - Config: /Users/rgareev91/.twilio-cli/config.json
```

**Available Topics:**
- `api` - Advanced access to all Twilio APIs
- `phone-numbers` - Manage phone numbers
- `debugger` - View log events
- `email` - SendGrid email operations
- `config` - CLI configuration
- `profiles` - Manage credentials

**Common Commands:**

```bash
# List phone numbers
twilio phone-numbers:list

# List recent calls (default format)
twilio api:core:calls:list --limit 10

# List calls in JSON format
twilio api:core:calls:list --limit 10 -o json

# Get specific call details
twilio api:core:calls:fetch --sid CA... -o json

# Create outbound call
twilio api:core:calls:create \
  --from "+16175006181" \
  --to "+15551234567" \
  --url "http://demo.twilio.com/docs/voice.xml"

# View call recordings
twilio api:core:calls:recordings:list --call-sid CA...

# Access debugger logs
twilio debugger:logs:list --limit 20
```

**Call Data Structure (JSON):**

```json
{
  "sid": "CA1a3e06d4e794b5ad5cb412c9e11d4219",
  "accountSid": "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "from": "+15085140320",
  "fromFormatted": "(508) 514-0320",
  "to": "+16175006181",
  "toFormatted": "(617) 500-6181",
  "phoneNumberSid": "PNec159049f9d2a07f464d9d0b9fe9c30a",
  "status": "completed",
  "direction": "inbound",
  "startTime": "2026-02-04T02:52:52.000Z",
  "endTime": "2026-02-04T02:53:26.000Z",
  "duration": "34",
  "price": null,
  "priceUnit": "USD",
  "parentCallSid": null,
  "forwardedFrom": "+16175006181",
  "answeredBy": null,
  "queueTime": "0",
  "dateCreated": "2026-02-04T02:52:52.000Z",
  "dateUpdated": "2026-02-04T02:53:26.000Z",
  "subresourceUris": {
    "recordings": "/2010-04-01/Accounts/AC.../Calls/CA.../Recordings.json",
    "events": "/2010-04-01/Accounts/AC.../Calls/CA.../Events.json",
    "notifications": "/2010-04-01/Accounts/AC.../Calls/CA.../Notifications.json",
    "transcriptions": "/2010-04-01/Accounts/AC.../Calls/CA.../Transcriptions.json",
    "payments": "/2010-04-01/Accounts/AC.../Calls/CA.../Payments.json"
  }
}
```

**Call Direction Types:**
- `inbound` - Incoming call to your Twilio number
- `outbound-api` - Outgoing call created via API
- `outbound-dial` - Outgoing call leg (e.g., forwarded call)

**Call Status Values:**
- `queued` - Call is waiting to be initiated
- `ringing` - Call is currently ringing
- `in-progress` - Call is active
- `completed` - Call finished successfully
- `busy` - Recipient was busy
- `no-answer` - Call was not answered
- `canceled` - Call was canceled before connection
- `failed` - Call failed to connect

**Important Findings for Integration:**

1. **Phone Number Formatting:**
   - Twilio provides `fromFormatted` and `toFormatted`
   - Compatible with our `formatPhoneNumber()` utility
   - Format: "(XXX) XXX-XXXX" for US numbers

2. **Parent/Child Calls:**
   - `parentCallSid` links child calls to parent
   - Used for forwarded/transferred calls
   - Important for conversation threading

3. **Recordings:**
   - Accessible via `subresourceUris.recordings`
   - Can fetch recording URL for playback
   - Need to handle recording permissions

4. **Duration:**
   - Always in seconds (integer)
   - Our `formatDuration()` utility compatible

5. **Timestamps:**
   - ISO 8601 format with timezone
   - `date-fns` library can parse directly

**Current Account Data:**

```bash
# Phone Numbers (3):
+18774194983  (877) 419-4983
+16175006181  (617) 500-6181
+16179927291  (617) 992-7291

# Recent Activity:
✅ Active calls present
✅ SIP integration configured (dispatcher@abchomes.sip.us1.twilio.com)
✅ Call forwarding in use
```

### 2. Front App API (Future)

**Purpose:** Sync call data to Front (not currently active)  
**Documentation:** https://dev.frontapp.com/reference  
**Status:** Infrastructure ready, not in use

**Endpoints (if activated):**
- `POST /channels/{channel_id}/inbound_messages` - Sync incoming calls
- `POST /channels/{channel_id}/outbound_messages` - Sync outgoing calls

**Authentication:** JWT-based (implemented in `jwtService.js`)

**Webhooks Received:**
- `POST /webhooks/front/channel` - Message import confirmations

### 3. PostgreSQL (Phase 2)

**Purpose:** Store conversations, messages, contacts  
**Documentation:** https://node-postgres.com/  
**Status:** Not yet configured

**Connection Library:** `pg` (PostgreSQL client for Node.js)

---

## 📁 Project Structure

```
twilio-front-integration/
├── frontend/                    # React application
│   ├── src/
│   │   ├── components/         # UI components
│   │   ├── pages/              # Route pages
│   │   ├── hooks/              # React Query hooks
│   │   ├── services/           # API client
│   │   ├── types/              # TypeScript types
│   │   └── utils/              # Formatters
│   ├── package.json
│   └── vite.config.ts
│
├── src/                         # Backend application
│   ├── routes/
│   │   ├── health.js           # Health check endpoints
│   │   └── webhooks.js         # Twilio/Front webhooks
│   └── services/
│       ├── jwtService.js       # JWT generation for Front API
│       ├── frontAPI.js         # Front Channel API client
│       └── callFormatter.js    # Twilio → Front converter
│
├── tests/                       # Test suite
│   ├── jwtService.test.js
│   └── callFormatter.test.js
│
├── .env.example                 # Environment template
├── .gitignore                   # Git ignore rules
├── package.json                 # Backend dependencies
├── GIT_WORKFLOW.md             # Git procedures
├── VERSION_HISTORY.md          # Version tracking
└── PROJECT_ENV.md              # This file
```

---

## ✅ Implemented Features

### Phase 1: Infrastructure & Frontend (Complete)

#### Backend Services ✅
- [x] Express server setup with middleware
- [x] JWT service for Front API authentication
- [x] Front Channel API client
- [x] Call formatter (Twilio → Front message format)
- [x] Webhook handlers (Front + Twilio)
  - [x] Signature verification
  - [x] Event processing
  - [x] Duplicate prevention (in-memory)
- [x] Health check endpoints
- [x] Test suite (27 tests, all passing)

#### Frontend Application ✅
- [x] React 19 + TypeScript setup
- [x] Vite development server
- [x] React Router navigation
- [x] TanStack Query for data fetching
  - [x] Auto-polling (10s for conversations, 5s for messages)
- [x] TypeScript models (Contact, Call, Message, Conversation)
- [x] API client with Axios
- [x] UI Components:
  - [x] AppLayout (header + main content)
  - [x] ConversationList (with loading/error/empty states)
  - [x] ConversationListItem (with navigation)
  - [x] HomePage (two-panel inbox layout)
  - [x] ConversationPage (conversation detail view)
- [x] Utility functions:
  - [x] Phone number formatting (US: +1 (XXX) XXX-XXXX)
  - [x] Duration formatting (3m 45s)
  - [x] Date/time formatting (relative and absolute)
  - [x] Status colors and emoji
- [x] Front-inspired design system
- [x] Responsive layout

#### Development Tools ✅
- [x] Git version control initialized
- [x] Commit guidelines documented
- [x] Rollback procedures
- [x] Jest test framework
- [x] ESLint configuration
- [x] Twilio CLI setup and authentication
- [x] Environment documentation (PROJECT_ENV.md)

### Phase 2: Backend API & Database (Planned)

#### Database Layer 🔲
- [ ] PostgreSQL schema
  - [ ] `contacts` table
  - [ ] `conversations` table
  - [ ] `messages` table
- [ ] Database migrations
- [ ] Query layer with `pg` library

#### API Endpoints 🔲
- [ ] `GET /api/conversations` - List conversations
- [ ] `GET /api/conversations/:id` - Get conversation details
- [ ] `GET /api/conversations/:id/messages` - Get call history
- [ ] Pagination support
- [ ] Filtering and sorting

#### Twilio Integration 🔲
- [ ] Twilio sync service
- [ ] Automatic call polling
- [ ] Webhook processing with database writes
- [ ] Call grouping into conversations
- [ ] Recording URL handling

#### Real-time Updates 🔲
- [ ] WebSocket server (optional)
- [ ] Live call events
- [ ] Frontend WebSocket client

### Phase 3: Production Deployment (Future)

- [ ] Production build configuration
- [ ] Environment-specific configs
- [ ] Logging (Winston)
- [ ] Error tracking (Sentry)
- [ ] Metrics collection
- [ ] SSL/HTTPS setup
- [ ] Deployment to cloud provider
- [ ] CI/CD pipeline

---

## 🚢 Deployment Procedures

### Development Deployment

**Current Status:** Local development only

**Process:**
1. Ensure `.env` files are configured
2. Start backend: `npm run dev`
3. Start frontend: `cd frontend && npm run dev`
4. Access at http://localhost:3001

### Production Deployment (Planned)

**Steps:**
1. Build frontend
   ```bash
   cd frontend
   npm run build
   # Output: frontend/dist/
   ```

2. Configure production environment
   ```bash
   # Set NODE_ENV=production
   # Configure DATABASE_URL
   # Set CALLBACK_HOSTNAME to public URL
   ```

3. Start backend in production mode
   ```bash
   npm start
   ```

4. Serve frontend build
   - Option A: Serve from Express (add static middleware)
   - Option B: Deploy to CDN (Vercel, Netlify)
   - Option C: Use nginx reverse proxy

5. Configure webhooks
   - Twilio: Point webhooks to `https://yourdomain.com/webhooks/twilio/*`
   - Front: Point webhooks to `https://yourdomain.com/webhooks/front/*`

**Deployment Checklist:**
- [ ] Environment variables configured
- [ ] Database migrations run
- [ ] Frontend built and optimized
- [ ] SSL certificates installed
- [ ] Webhooks configured
- [ ] Health checks passing
- [ ] Monitoring enabled
- [ ] Backups configured

---

## 🐛 Troubleshooting

### Backend Won't Start

**Symptom:** Port 3000 already in use  
**Solution:**
```bash
lsof -i :3000
kill -9 <PID>
npm run dev
```

**Symptom:** Missing environment variables  
**Solution:**
```bash
cp .env.example .env
# Edit .env with actual values
npm run dev
```

### Frontend Shows 500 Errors

**Symptom:** `/api/conversations` returns 500  
**Solution:**
- Backend endpoints not implemented yet (expected in Phase 1)
- Will be resolved in Phase 2 when API endpoints are added

**Symptom:** Proxy not working  
**Solution:**
- Verify backend is running on port 3000
- Check `vite.config.ts` proxy configuration
- Restart frontend dev server

### Tests Failing

**Symptom:** Jest tests fail  
**Solution:**
```bash
# Clear cache and reinstall
rm -rf node_modules package-lock.json
npm install
npm test
```

### Database Connection Issues (Phase 2)

**Symptom:** Cannot connect to PostgreSQL  
**Solution:**
- Verify PostgreSQL is running: `pg_isready`
- Check DATABASE_URL format
- Verify credentials
- Check firewall/network access

---

## 📚 Documentation Resources

### Project Documentation

- **Git Workflow:** [GIT_WORKFLOW.md](./GIT_WORKFLOW.md)
- **Version History:** [VERSION_HISTORY.md](./VERSION_HISTORY.md)
- **Backend README:** [README.md](./README.md)
- **Frontend README:** [frontend/README.md](./frontend/README.md)

### External Documentation

**Twilio:**
- Voice API: https://www.twilio.com/docs/voice/api
- Webhooks: https://www.twilio.com/docs/usage/webhooks
- Node SDK: https://www.twilio.com/docs/libraries/node
- Signature Validation: https://www.twilio.com/docs/usage/webhooks/webhooks-security

**Front:**
- Channel API: https://dev.frontapp.com/reference
- Plugin SDK: https://dev.frontapp.com/docs/plugin-sdk-reference
- Front UI Kit: https://dev.frontapp.com/docs/front-ui-kit
- Authentication: https://dev.frontapp.com/docs/create-and-revoke-api-tokens

**React & Tools:**
- React: https://react.dev
- Vite: https://vite.dev
- React Router: https://reactrouter.com
- TanStack Query: https://tanstack.com/query/latest
- TypeScript: https://www.typescriptlang.org/docs

**Node.js:**
- Express: https://expressjs.com
- Jest: https://jestjs.io
- Axios: https://axios-http.com
- PostgreSQL (pg): https://node-postgres.com

---

## 🔄 Maintenance Requirements

### This Document Must Be Updated When:

1. **New Environment Variables Added**
   - Add to `.env.example`
   - Document in "Environment Configuration" section
   - Update "Where to Get" instructions

2. **New API/Service Integration**
   - Add to "External Services & APIs" section
   - Document credentials required
   - Add documentation links
   - Update "Implemented Features"

3. **Deployment Process Changes**
   - Update "Deployment Procedures"
   - Update deployment checklist

4. **New Features Implemented**
   - Mark checkboxes in "Implemented Features"
   - Update project status/version
   - Update "last_updated" in YAML frontmatter

5. **Server/Port Configuration Changes**
   - Update "Server Management" section
   - Update verification commands

6. **Troubleshooting Solutions Found**
   - Add to "Troubleshooting" section
   - Document solution steps

### Update Process

1. Edit this file: `PROJECT_ENV.md`
2. Update `last_updated` date in YAML frontmatter
3. Commit changes:
   ```bash
   git add PROJECT_ENV.md
   git commit -m "docs: Update PROJECT_ENV.md - <description of changes>"
   ```

### Review Schedule

- **Minor updates:** As changes occur
- **Full review:** At the end of each development phase
- **Version bump:** When major features are added

---

## 📊 Current Status Summary

**Project Version:** 0.1.0  
**Phase:** 1 Complete, 2 Starting  
**Backend Status:** ✅ Infrastructure ready, 🔲 API endpoints needed  
**Frontend Status:** ✅ Complete and running  
**Database Status:** 🔲 Not configured  
**Deployment Status:** 🔲 Local development only  

**Last Updated:** 2026-02-04  
**Next Milestone:** Phase 2 - Backend API + Database Integration

---

> ⚠️ **REMINDER:** Keep this document up-to-date! It's the single source of truth for project environment and configuration.
