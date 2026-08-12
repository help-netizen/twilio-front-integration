/// <reference types="google.maps" />
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlacesAutocomplete, { getDetails } from 'use-places-autocomplete';
import { Loader2 } from 'lucide-react';
import { parseAddressComponents, parseDescription, stateFromZip, type AddressFields, type SuggestionItem } from './addressAutoHelpers';
import { loadGoogleMaps } from '../utils/loadGoogleMaps';

/**
 * A ONE-LINE Google Places autocomplete field — the single-value sibling of
 * {@link AddressAutocomplete} (which renders the full street/apt/city/state/zip form).
 *
 * Use it where the entity stores a free-text location as ONE string but we still want
 * real suggestions instead of a hand-typed guess — e.g. a technician's start location.
 * Picking a suggestion also hands back the resolved {@link AddressFields} INCLUDING
 * lat/lng, so a caller can persist exact coordinates rather than leaving the server to
 * re-geocode the text (which is what silently resolves to the wrong place).
 *
 * Deliberate differences from AddressAutocomplete:
 *  - No first-space gate. That gate (`hasFirstSpaceGate`) never fires for a bare ZIP,
 *    and these fields accept "just a ZIP" — we trigger on `minChars` instead.
 *  - The input is NEVER disabled. Maps is loaded async app-wide (main.tsx); if it is
 *    slow or unconfigured the field must still accept typed text, just without
 *    suggestions. Disabling it would strand the user.
 */

interface PlaceAutocompleteInputProps {
    id: string;
    label: string;
    /** The text shown in the field (the caller owns it). */
    value: string;
    /** Free typing — no place resolved, so any previously picked coordinates are stale. */
    onChange: (text: string) => void;
    /** A suggestion was chosen: `address` is the display text, `fields` carries lat/lng. */
    onPick: (picked: { address: string; fields: AddressFields }) => void;
    /** Suggestions start after this many characters (a 5-digit ZIP must qualify). */
    minChars?: number;
    disabled?: boolean;
}

function Spinner() { return <Loader2 className="size-4 animate-spin" />; }

/** Fill State from ZIP when the pick omitted it (mirrors AddressAutocomplete). */
function withDerivedState(f: AddressFields): AddressFields {
    return (!f.state && /^\d{5}/.test(f.zip || '')) ? { ...f, state: stateFromZip(f.zip) || '' } : f;
}

export function PlaceAutocompleteInput({
    id, label, value, onChange, onPick, minChars = 3, disabled = false,
}: PlaceAutocompleteInputProps) {
    const [activeIndex, setActiveIndex] = useState(-1);
    const [open, setOpen] = useState(false);
    const [detailsLoading, setDetailsLoading] = useState(false);
    const blurTimer = useRef<number | undefined>(undefined);

    const {
        ready, suggestions: { loading, status, data }, setValue: setSearchValue, clearSuggestions, init,
    } = usePlacesAutocomplete({
        initOnMount: false, // Maps loads async — init explicitly once it's actually there.
        debounce: 200,
        cache: 60,
        requestOptions: { componentRestrictions: { country: ['us'] } },
    });

    // main.tsx kicks the load off app-wide; awaiting it here removes the mount race
    // (a dialog opened before the script lands would otherwise never become ready).
    useEffect(() => {
        let cancelled = false;
        loadGoogleMaps().then(() => { if (!cancelled) init(); }).catch(() => { /* typed text still works */ });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => () => window.clearTimeout(blurTimer.current), []);

    const suggestions = useMemo(
        () => (data || []).slice(0, 6).map((item: google.maps.places.AutocompletePrediction) => ({
            place_id: item.place_id, description: item.description,
        })) as SuggestionItem[],
        [data],
    );

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const next = e.target.value;
        onChange(next);
        setActiveIndex(-1);
        if (next.trim().length < minChars) { clearSuggestions(); setSearchValue(next, false); setOpen(false); return; }
        setOpen(true);
        setSearchValue(next, true);
    };

    const selectSuggestion = useCallback(async (item: SuggestionItem) => {
        clearSuggestions();
        setActiveIndex(-1);
        setOpen(false);
        setSearchValue(item.description, false);

        // No place_id → nothing to resolve; keep the text and let the server geocode.
        if (!item.place_id) {
            onPick({ address: item.description, fields: withDerivedState(parseDescription(item.description)) });
            return;
        }
        setDetailsLoading(true);
        try {
            const result = await getDetails({ placeId: item.place_id, fields: ['address_components', 'geometry'] });
            const fields = (result && typeof result === 'object' && 'address_components' in result && result.address_components)
                ? parseAddressComponents(result.address_components, result.geometry)
                : parseDescription(item.description);
            onPick({ address: item.description, fields: withDerivedState(fields) });
        } catch (err) {
            // Details failed → still emit the chosen text (server geocodes as before).
            console.error('Place Details error:', err);
            onPick({ address: item.description, fields: withDerivedState(parseDescription(item.description)) });
        } finally {
            setDetailsLoading(false);
        }
    }, [clearSuggestions, setSearchValue, onPick]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (!suggestions.length) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, suggestions.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)); }
        else if (e.key === 'Enter') { if (activeIndex >= 0 && activeIndex < suggestions.length) { e.preventDefault(); selectSuggestion(suggestions[activeIndex]); } }
        else if (e.key === 'Escape') { clearSuggestions(); setActiveIndex(-1); setOpen(false); }
    };

    const showDropdown = open && ready && (loading || status === 'OK') && (loading || suggestions.length > 0);

    // PALETTE-V2 filled canon — the floated label lives INSIDE the fill, no bg patch.
    const floatLabel = 'pointer-events-none absolute left-3 z-10 px-1 bg-transparent font-normal text-[var(--blanc-ink-3)] transition-all duration-150 top-1/2 -translate-y-1/2 text-[15px] peer-focus:top-[6px] peer-focus:translate-y-0 peer-focus:text-[11px] peer-[:not(:placeholder-shown)]:top-[6px] peer-[:not(:placeholder-shown)]:translate-y-0 peer-[:not(:placeholder-shown)]:text-[11px]';

    return (
        <div className="relative">
            <input
                id={id}
                value={value}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onFocus={() => { if (value.trim().length >= minChars && suggestions.length) setOpen(true); }}
                onBlur={() => { blurTimer.current = window.setTimeout(() => setOpen(false), 200); }}
                disabled={disabled}
                placeholder=" "
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                className="peer h-[50px] w-full rounded-xl border-[1.5px] border-transparent bg-[var(--blanc-field,#F0F0F0)] px-3.5 pt-[22px] pb-[6px] text-[15px] font-medium text-[var(--blanc-ink-1)] outline-none placeholder:text-transparent transition-colors focus:border-[var(--blanc-line-strong)] disabled:cursor-not-allowed disabled:opacity-50"
            />
            <label htmlFor={id} className={floatLabel}>{label}</label>
            {detailsLoading && (
                <div className="mt-1.5 flex items-center gap-1.5">
                    <Spinner /><span className="text-xs text-muted-foreground">Resolving address…</span>
                </div>
            )}
            {showDropdown && (
                <div role="listbox" className="absolute z-50 mt-1 w-full rounded-md border border-gray-200 bg-[#f3f3f5] shadow-md overflow-hidden">
                    {loading && <div className="px-3 py-2 flex items-center gap-2 text-sm text-muted-foreground"><Spinner />Loading…</div>}
                    {!loading && suggestions.map((item, idx) => (
                        <div
                            key={`${item.place_id || item.description}-${idx}`}
                            role="option"
                            aria-selected={idx === activeIndex}
                            onMouseDown={ev => { ev.preventDefault(); selectSuggestion(item); }}
                            onMouseEnter={() => setActiveIndex(idx)}
                            className={`cursor-pointer px-3 py-2 text-sm transition-colors ${idx === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'}`}
                        >
                            {item.description}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
