import type { ReactNode } from 'react';

// ─── PageLayout ───────────────────────────────────────────────────────────────
// Universal page layout component that enforces the blanc design system pattern:
//   title on warm gradient background → frosted glass toolbar → floating content card
//
// Usage:
//   <PageLayout title="My Page" actions={<Button>Create</Button>} toolbar={<MyFilters />}>
//       <MyTable />
//   </PageLayout>
//
// Every new page that uses this automatically gets:
//   - Large Manrope heading
//   - Large primary action button(s)
//   - Frosted glass toolbar with lifted controls
//   - Opaque floating content card
// ─────────────────────────────────────────────────────────────────────────────

interface PageLayoutProps {
    /** Page title — rendered as a large Manrope h1 */
    title: ReactNode;
    /** Action buttons shown on the right side of the header (e.g. "Create Lead") */
    actions?: ReactNode;
    /** Toolbar content — search, filters, date pickers. Rendered in frosted glass bar. */
    toolbar?: ReactNode;
    /** Main content — rendered inside the floating card. */
    children: ReactNode;
    /** Set to true to skip the floating card wrapper (e.g. pages with a split-panel layout) */
    noCard?: boolean;
}

export function PageLayout({ title, actions, toolbar, children, noCard }: PageLayoutProps) {
    return (
        <div className="blanc-page-wrapper">
            {/* Header: title + actions */}
            <div className="blanc-page-header">
                <h1 className="blanc-heading blanc-heading-lg">{title}</h1>
                {actions && <div className="flex items-center gap-2">{actions}</div>}
            </div>

            {/* Toolbar: filters, search, etc. */}
            {toolbar && (
                <div className="blanc-page-toolbar">
                    {toolbar}
                </div>
            )}

            {/* Content */}
            {noCard ? children : (
                <div className="blanc-page-card">
                    {children}
                </div>
            )}
        </div>
    );
}

export default PageLayout;
