# SOFTPHONE-NATIVE-001 — Native softphone backend

## Stage 2 decisions

- The existing group/call-flow routing graph is unchanged. Twilio receives the
  same tenant-stable `<Client>` identity and fans it out to browser WebSocket and
  registered mobile push bindings; first accept wins.
- Stage 1 is outbound-only. Incoming continues to route to desktop/Sara exactly
  as before; the known inbound-concurrency limitation is accepted for that stage.
- “Connected” is an explicit app toggle matching the desktop widget. The native
  softphone is offered by the phone-number chooser only while that toggle is on
  and a token is obtainable.
- Masked viewers use only the carrier-masked `tel_uri` path in Stage 1. The
  chooser hides native softphone for them and fails closed.
- Native integration targets the latest stable 1.x release of
  `@twilio/voice-react-native-sdk`; dependency/pod/UI work is outside this backend change.
- Native features mirror the widget exactly: dial, caller-ID selection, mute,
  DTMF, hangup, and call duration. There is no hold or transfer.
- A Pulse deep-link after incoming accept is Stage 2, asynchronous, and non-blocking.
- `GET /api/voice/token` remains the browser/Stage 1 token contract. Native
  incoming uses `GET /api/voice/token/native`, whose VoiceGrant adds the
  account-local `pushCredentialSid` while retaining the same identity and
  outgoing TwiML Application.
- Each tenant subaccount stores its own `company_telephony.ios_push_credential_sid`.
  `TWILIO_IOS_PUSH_CREDENTIAL_SID` is a master/default-company fallback only;
  account-scoped credentials are never crossed into a subaccount token.
- `POST /api/voice/native-registration` is called only after `voice.register()`
  succeeds. `DELETE` is called after unregister/toggle-off. There is no separate
  server toggle: the unexpired registration row is the native “connected” signal.
- Registrations expire after 30 days unless refreshed. Routing still requires
  active group membership, `phone_calls_allowed`, and a non-busy identity. Native
  registration is ORed with browser availability; the existing busy-identity
  check remains the call-concurrency guard.
- Call masking and the routing structure are unchanged.

## Migration hazard memo

On 2026-08-03, remote `refs/heads/master` and local `origin/master` both resolved
to `85ede29de4585d7abdc96941704df525d35ef86a`; its maximum migration was 231.
This feature therefore uses forward/rollback migration 232. Re-check the remote
ref immediately before integration and renumber both files if 232 has been taken.
