# Twilio-Front Integration

Integration server for syncing Twilio call history into Front as an Application Channel.

## Features

- ✅ Sync Twilio call records (inbound/outbound) to Front
- ✅ Real-time webhook support from Twilio
- ✅ Webhook integration with Front Channel API
- ✅ JWT-based authentication for Front API
- ✅ Markdown formatting for call details
- ✅ Threading calls by phone number
- ✅ Signature verification for security

## Architecture

```
Twilio API ←→ Integration Server ←→ Front Channel API
              ↑ webhooks from both
```

## Setup

### Prerequisites

- Node.js 18+
- Twilio account with API credentials
- Front app with Application Channel configured
- PostgreSQL (for production)

### Installation

```bash
npm install
```

### Configuration

1. Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

2. Fill in your credentials in `.env`:
```env
FRONT_APP_UID=your_app_uid
FRONT_APP_SECRET=your_app_secret
TWILIO_ACCOUNT_SID=ACxxxxx
TWILIO_AUTH_TOKEN=xxxxx
```

3. Set up your webhook URLs in:
   - **Front App Settings** → Webhook URL: `https://your-server.com/webhooks/front/channel`
   - **Twilio Console** → Phone Number → Voice Webhooks:
     - Status Callback: `https://your-server.com/webhooks/twilio/status`
     - Call Comes In: `https://your-server.com/webhooks/twilio/incoming`

## Development

### Run locally

```bash
npm run dev
```

Server will start on http://localhost:3000

### Test webhooks locally with ngrok

```bash
# Install ngrok
npm install -g ngrok

# Start ngrok tunnel
ngrok http 3000

# Use the ngrok URL in your Front/Twilio webhook settings
```

## API Endpoints

### Health Check
```
GET /health
```

### Webhooks
```
POST /webhooks/front/channel    - Receives events from Front
POST /webhooks/twilio/status    - Receives call status from Twilio
POST /webhooks/twilio/incoming  - Receives incoming call notifications
```

## Project Structure

```
twilio-front-integration/
├── src/
│   ├── server.js                 # Main Express app
│   ├── routes/
│   │   ├── health.js            # Health check endpoints
│   │   └── webhooks.js          # Webhook handlers
│   ├── services/
│   │   ├── jwtService.js        # JWT token generation
│   │   ├── frontAPI.js          # Front Channel API client
│   │   └── callFormatter.js     # Twilio call → Front message
│   ├── db/
│   │   └── models.js            # Database models (TODO)
│   └── utils/
│       └── logger.js            # Logging utilities (TODO)
├── tests/
│   └── *.test.js                # Unit tests (TODO)
├── .env.example                  # Environment template
├── .gitignore
├── package.json
└── README.md
```

## Next Steps

1. ✅ Core services implemented (JWT, Front API, Call Formatter)
2. ✅ Basic webhook handlers
3. 🔲 Implement sync service for full call synchronization
4. 🔲 Add database layer (PostgreSQL)
5. 🔲 Add polling service for historical calls
6. 🔲 Add tests
7. 🔲 Add proper logging (Winston)
8. 🔲 Deploy to production

## Testing

```bash
# Run tests (when implemented)
npm test

# Run tests with coverage
npm run test:coverage
```

## Deployment

See [deployment guide](./DEPLOYMENT.md) for production deployment instructions.

## License

ISC
