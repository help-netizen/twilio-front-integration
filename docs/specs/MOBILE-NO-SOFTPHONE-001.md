# MOBILE-NO-SOFTPHONE-001 — hide the browser softphone on mobile

Status: PLANNED (orchestrate, 2026-06-27). Owner-reported; advisory established first.

## Why
The softphone is a Twilio **WebRTC Device** (`@twilio/voice-sdk`). On mobile browsers (iOS = WebKit) it's
unreliable: a backgrounded/locked tab drops the Device registration → calls don't ring; foreground audio is
flaky. On mobile it only causes confusion (warm-up modal on every load/login, an incoming-call screen that
doesn't work). Decision: disable it on mobile; keep desktop unchanged. (Call-forwarding-to-cell is a
possible LATER feature, not now.)

## Decisions (owner)
- D1: On mobile (`useIsMobile`, breakpoint 768 — reuse existing hook) the softphone is **fully off**:
  no nav button, no widget/warm-up modal, no incoming-call screen, and the **Twilio Device never registers**.
- D2: Per-row "Call" buttons (`ClickToCallButton`) on mobile → open the **native dialer** (`tel:`); desktop
  keeps the in-app softphone dialer.
- D3: Desktop fully unchanged. Frontend-only; no backend/Twilio/Keycloak/DB change.

## Implementation
- `AppLayout.tsx`: `const isMobile = useIsMobile();` →
  `softPhoneEnabled = !isMobile && softPhoneGroupsLoaded && groups>0`. This disables `useTwilioDevice`
  (enabled:false → no `new Device`/register/getUserMedia), the nav button (gated on softPhoneEnabled),
  the warm-up Dialog (showWarmUp only set when softPhoneEnabled), and the incoming auto-open. Also gate the
  `<SoftPhoneWidget>` render on `!isMobile`. (Verified: `useTwilioDevice` tears down via `Device.destroy()`
  if enabled flips true→false on a desktop→mobile resize.)
- `ClickToCallButton.tsx`: on `useIsMobile()` render `<a href="tel:${digits}">`; else the existing button.
  `ClickToCallButton.css`: `text-decoration:none` (anchor). Mobile already forces the button visible
  (`@media (max-width:767px){opacity:1}`).

## Verify
`npm run build` green; reviewer APPROVED (Device not registered on mobile; desktop byte-for-byte unchanged;
no other softphone UI on mobile; BottomNavBar has no call entry). Deploy: frontend app rebuild + logout-all.
Owner check on phone: no softphone button/modal/incoming screen; tapping a number's "Call" opens the dialer.
