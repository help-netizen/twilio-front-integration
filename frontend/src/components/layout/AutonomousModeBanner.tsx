/**
 * AutonomousModeBanner — persistent, app-wide bottom status bar shown while
 * telephony autonomous mode is ON (TELEPHONY-AUTONOMOUS-MODE-001).
 *
 * NOT dismissible: it reflects a company-wide operational state (all incoming
 * calls handled as after-hours), so every user on every page must see it while
 * it's on. Amber/warning styling via Albusto tokens.
 *
 * Placement is a slim fixed strip at the bottom. On mobile it is lifted to sit
 * ABOVE the bottom nav (which is 60px + safe-area, z-index 90) via the
 * `.autonomous-banner` CSS in AppLayout.css, so it never covers the nav /
 * softphone controls. `.app-layout.has-autonomous-banner` adds matching bottom
 * padding to `.app-main` so page content is never obscured.
 */

import { AlertTriangle } from 'lucide-react';

export function AutonomousModeBanner({ visible }: { visible: boolean }) {
    if (!visible) return null;

    return (
        <div
            className="autonomous-banner"
            role="status"
            aria-live="polite"
            style={{
                position: 'fixed',
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 100,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: '9px 16px',
                // Warm amber wash with a legible warning-toned text + top hairline,
                // consistent with the Albusto palette (no hard border-as-noise on the sides).
                background: 'color-mix(in srgb, var(--blanc-warning, #b26a1d) 14%, var(--blanc-surface-strong, #fdf8f0))',
                borderTop: '1px solid color-mix(in srgb, var(--blanc-warning, #b26a1d) 38%, transparent)',
                color: 'var(--blanc-warning, #b26a1d)',
                fontFamily: 'var(--blanc-font-body, "IBM Plex Sans", sans-serif)',
                fontSize: 13,
                fontWeight: 600,
                lineHeight: 1.3,
                textAlign: 'center',
                boxShadow: '0 -8px 24px -18px rgba(63, 55, 42, 0.5)',
            }}
        >
            <AlertTriangle size={15} style={{ flexShrink: 0 }} />
            <span>
                Autonomous mode is ON — all incoming calls are handled as after-hours.
            </span>
        </div>
    );
}
