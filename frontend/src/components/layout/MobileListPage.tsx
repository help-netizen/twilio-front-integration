/**
 * MobileListPage — the canonical shell for mobile list pages (TASKS-MOBILE-TILES-001).
 *
 * ONE definition adopted by the mobile Jobs / Leads / Tasks pages so their side
 * inset, scroll model and bottom-nav clearance stay identical and never drift
 * again (the project's canon pattern — cf. SHEET-CANON, OVERLAY-CLOSE-CANON).
 *
 * Why it exists: Jobs/Leads previously wrapped their mobile list in a
 * `flex-1 overflow-y-auto` scroller inside a `.blanc-page-wrapper` that is
 * `overflow:hidden` — so `.app-main`'s `padding-bottom: calc(60px + safe-area)`
 * (the fixed bottom-nav clearance) was inert: the last tile sat almost under the
 * nav, and a short list left a big flex:1 void below the content. This shell
 * removes that inner scroller entirely — the page scrolls in `.app-main` (the
 * model Tasks already used correctly). The shell root is block flow (NOT flex):
 * a flex-column scroll child drops its trailing padding from the scrollable
 * overflow, which is what made the nav-clearance inert; block flow keeps it, so
 * the last tile clears the nav comfortably. Uniform `--blanc-bg` background, no
 * bordered sub-card, so a short list just leaves plain space.
 *
 * DESKTOP is untouched — pages render this ONLY behind `useIsMobile()`, keeping
 * their `.blanc-page-wrapper` desktop layout byte-identical.
 *
 * Composition:
 *   <MobileListPage stickyBar={<XMobileBar/> | header}>
 *     …grouped tiles / list…
 *   </MobileListPage>
 *
 * Styling lives in AppLayout.css (`.mobile-list-page*`).
 */

import React from 'react';

interface MobileListPageProps {
    /** Pinned top bar (search + gear, or a page header). Sticks to the app-main scroll top. */
    stickyBar: React.ReactNode;
    /** The scrollable list content (grouped tiles + Load-more). */
    children: React.ReactNode;
}

export const MobileListPage: React.FC<MobileListPageProps> = ({ stickyBar, children }) => (
    <div className="mobile-list-page">
        <div className="mobile-list-page__bar">{stickyBar}</div>
        <div className="mobile-list-page__content">{children}</div>
    </div>
);

export default MobileListPage;
