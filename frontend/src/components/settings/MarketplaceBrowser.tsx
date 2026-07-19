import { useMemo, useState, type ReactNode } from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import type { MarketplaceApp } from '../../services/marketplaceApi';
import { useIsMobile } from '../../hooks/useIsMobile';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { FilterColumn } from '../jobs/jobsFilterHelpers';
import {
    filterMarketplaceApps,
    groupMarketplaceApps,
    MARKETPLACE_CATALOGS,
    toggleMarketplaceCatalog,
    type MarketplaceCatalogId,
} from './marketplaceCatalog';
import { MarketplaceCatalogSections } from './MarketplaceCatalogSections';

interface MarketplaceFilterBodyProps {
    searchQuery: string;
    onSearchQueryChange: (value: string) => void;
    selectedCatalogs: MarketplaceCatalogId[];
    onSelectedCatalogsChange: (value: MarketplaceCatalogId[]) => void;
    showSearch: boolean;
}

function MarketplaceFilterBody({
    searchQuery,
    onSearchQueryChange,
    selectedCatalogs,
    onSelectedCatalogsChange,
    showSearch,
}: MarketplaceFilterBodyProps) {
    const selectedLabels = selectedCatalogs.map(
        id => MARKETPLACE_CATALOGS.find(catalog => catalog.id === id)!.label,
    );
    const catalogLabels = MARKETPLACE_CATALOGS.map(catalog => catalog.label);

    const toggleCatalogByLabel = (label: string) => {
        const catalog = MARKETPLACE_CATALOGS.find(item => item.label === label);
        if (!catalog) return;
        onSelectedCatalogsChange(toggleMarketplaceCatalog(selectedCatalogs, catalog.id));
    };

    const removeCatalog = (catalogId: MarketplaceCatalogId) => {
        onSelectedCatalogsChange(toggleMarketplaceCatalog(selectedCatalogs, catalogId));
    };

    return (
        <>
            {showSearch && (
                <div className="p-3 pb-0">
                    <div className="relative">
                        <Search
                            aria-hidden="true"
                            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--blanc-ink-3)]"
                        />
                        <Input
                            type="search"
                            autoFocus
                            aria-label="Search marketplace apps"
                            placeholder="Search apps or categories…"
                            value={searchQuery}
                            onChange={event => onSearchQueryChange(event.target.value)}
                            className="h-11 pl-10"
                        />
                    </div>
                </div>
            )}

            {selectedCatalogs.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 p-3 pb-0">
                    {selectedCatalogs.map(catalogId => {
                        const catalog = MARKETPLACE_CATALOGS.find(item => item.id === catalogId)!;
                        return (
                            <Badge key={catalog.id} variant="outline" className="gap-1 text-xs">
                                {catalog.label}
                                <button
                                    type="button"
                                    aria-label={`Remove ${catalog.label} filter`}
                                    onClick={() => removeCatalog(catalog.id)}
                                    className="rounded-sm"
                                >
                                    <X className="size-3" />
                                </button>
                            </Badge>
                        );
                    })}
                    <button
                        type="button"
                        onClick={() => onSelectedCatalogsChange([])}
                        className="ml-1 text-xs text-[var(--blanc-ink-2)] hover:text-[var(--blanc-ink-1)]"
                    >
                        Clear all
                    </button>
                </div>
            )}

            <div className="p-3">
                <FilterColumn
                    title="CATEGORIES"
                    items={catalogLabels}
                    selected={selectedLabels}
                    onToggle={toggleCatalogByLabel}
                />
            </div>
        </>
    );
}

interface MarketplaceBrowserProps {
    apps: MarketplaceApp[];
    renderApp: (app: MarketplaceApp) => ReactNode;
}

export function MarketplaceBrowser({ apps, renderApp }: MarketplaceBrowserProps) {
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCatalogs, setSelectedCatalogs] = useState<MarketplaceCatalogId[]>([]);
    const [filterOpen, setFilterOpen] = useState(false);
    const isMobile = useIsMobile();
    const filteredApps = useMemo(
        () => filterMarketplaceApps(apps, searchQuery, selectedCatalogs),
        [apps, searchQuery, selectedCatalogs],
    );
    const groups = useMemo(() => groupMarketplaceApps(filteredApps), [filteredApps]);
    const hasActiveSearch = searchQuery.trim().length > 0 || selectedCatalogs.length > 0;

    const clearSearchAndFilters = () => {
        setSearchQuery('');
        setSelectedCatalogs([]);
    };

    return (
        <div className="space-y-7">
            <Popover
                open={filterOpen}
                onOpenChange={setFilterOpen}
                sheetTitle="Filter marketplace apps"
            >
                <div className="relative max-w-xl">
                    <Search
                        aria-hidden="true"
                        className="pointer-events-none absolute left-3 top-1/2 z-[1] size-4 -translate-y-1/2 text-[var(--blanc-ink-3)]"
                    />
                    <PopoverTrigger asChild>
                        <Input
                            type="search"
                            aria-label="Search marketplace apps"
                            placeholder="Search apps or categories…"
                            value={searchQuery}
                            onChange={event => setSearchQuery(event.target.value)}
                            className="h-11 pl-10 pr-24"
                        />
                    </PopoverTrigger>
                    <span
                        aria-hidden="true"
                        className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5 text-[var(--blanc-ink-3)]"
                    >
                        <SlidersHorizontal className="size-4" />
                        {selectedCatalogs.length > 0 && (
                            <Badge variant="secondary" className="h-[18px] min-w-[18px] justify-center px-1.5 py-0 text-[10px]">
                                {selectedCatalogs.length}
                            </Badge>
                        )}
                    </span>
                </div>
                <PopoverContent
                    align="start"
                    sideOffset={8}
                    onOpenAutoFocus={event => {
                        if (!isMobile) event.preventDefault();
                    }}
                    className="overflow-hidden rounded-xl p-0"
                    style={{ width: 'min(520px, calc(100vw - 48px))' }}
                >
                    <MarketplaceFilterBody
                        searchQuery={searchQuery}
                        onSearchQueryChange={setSearchQuery}
                        selectedCatalogs={selectedCatalogs}
                        onSelectedCatalogsChange={setSelectedCatalogs}
                        showSearch={isMobile}
                    />
                </PopoverContent>
            </Popover>

            {groups.length > 0 ? (
                <MarketplaceCatalogSections groups={groups} renderApp={renderApp} />
            ) : (
                <div className="py-12 text-center">
                    <p className="font-medium text-[var(--blanc-ink-1)]">No apps found</p>
                    <p className="mt-1 text-sm text-[var(--blanc-ink-2)]">
                        Try a different search or category.
                    </p>
                    {hasActiveSearch && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={clearSearchAndFilters}
                            className="mt-3"
                        >
                            Clear search and filters
                        </Button>
                    )}
                </div>
            )}
        </div>
    );
}
