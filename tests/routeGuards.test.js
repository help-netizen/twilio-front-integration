/**
 * Regression guard: every page route must be behind an auth/permission gate.
 *
 * Prod leak: opening /payments (and any protected page) in a logged-out browser
 * rendered the CRM shell instead of redirecting to login, and /calls had no
 * ProtectedRoute at all. This test fails if a new <Route> is added without a
 * ProtectedRoute (unless it's an explicitly public/auth-only path or a redirect).
 *
 * The AuthProvider hard gate (unauthenticated → redirect, never render the shell)
 * is the runtime defense; this is the static net that catches missing guards.
 */

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '../frontend/src/App.tsx'), 'utf8');
const routeLines = APP.split('\n').filter(l => /<Route\s/.test(l));

// Routes that intentionally render without a ProtectedRoute permission gate:
//  - public (no auth at all): /signup, /pay/:token  (in AuthProvider PUBLIC_AUTH_PATHS)
//  - auth-only (login required via kc.init, but no specific permission): /onboarding
const ALLOWED_UNGUARDED = new Set(['/signup', '/pay/:token', '/onboarding']);

function pathOf(line) {
    const m = line.match(/path="([^"]+)"/);
    return m ? m[1] : null;
}

describe('App.tsx route guards', () => {
    it('found a non-trivial number of routes (sanity)', () => {
        expect(routeLines.length).toBeGreaterThan(40);
    });

    it('every page route is wrapped in ProtectedRoute (or is public / a redirect)', () => {
        const unguarded = [];
        for (const line of routeLines) {
            const routePath = pathOf(line);
            if (!routePath) continue;
            if (/<Navigate\b/.test(line)) continue;        // pure redirect → target is guarded
            if (ALLOWED_UNGUARDED.has(routePath)) continue; // intentionally public/auth-only
            if (/<ProtectedRoute\b/.test(line)) continue;   // guarded
            unguarded.push(routePath);
        }
        expect(unguarded).toEqual([]);
    });

    it('payments and calls routes require the expected permission', () => {
        const payments = routeLines.filter(l => /path="\/payments/.test(l));
        expect(payments.length).toBeGreaterThan(0);
        payments.forEach(l => expect(l).toMatch(/ProtectedRoute permissions=\{\['payments\.view'\]\}/));

        const calls = routeLines.find(l => /path="\/calls"/.test(l));
        expect(calls).toBeDefined();
        expect(calls).toMatch(/ProtectedRoute permissions=\{\['messages\.view_internal'\]\}/);
    });
});
