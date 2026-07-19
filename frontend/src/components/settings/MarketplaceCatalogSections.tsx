import { Fragment, type ReactNode } from 'react';
import type { MarketplaceApp } from '../../services/marketplaceApi';
import type { MarketplaceCatalogGroup } from './marketplaceCatalog';

interface MarketplaceCatalogSectionsProps {
    groups: MarketplaceCatalogGroup[];
    renderApp: (app: MarketplaceApp) => ReactNode;
}

export function MarketplaceCatalogSections({
    groups,
    renderApp,
}: MarketplaceCatalogSectionsProps) {
    return (
        <div className="space-y-9">
            {groups.map(({ catalog, apps }) => (
                <section
                    key={catalog.id}
                    data-marketplace-catalog={catalog.id}
                    aria-labelledby={`marketplace-catalog-${catalog.id}`}
                    className="space-y-3"
                >
                    <div className="flex items-baseline gap-2">
                        <h2
                            id={`marketplace-catalog-${catalog.id}`}
                            className="text-lg font-semibold text-[var(--blanc-ink-1)]"
                        >
                            {catalog.label}
                        </h2>
                        <span className="text-xs text-[var(--blanc-ink-3)]">
                            {apps.length} {apps.length === 1 ? 'app' : 'apps'}
                        </span>
                    </div>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        {apps.map(app => (
                            <Fragment key={app.app_key}>{renderApp(app)}</Fragment>
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}
