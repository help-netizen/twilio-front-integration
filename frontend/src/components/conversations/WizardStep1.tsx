/// <reference types="google.maps" />
import { useState, useMemo, useCallback } from 'react';
import usePlacesAutocomplete from 'use-places-autocomplete';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
import { PhoneInput } from '../ui/PhoneInput';
import { Loader2 } from 'lucide-react';
import { parseDescription } from '../addressAutoHelpers';
import type { WizardState } from './wizardTypes';

/**
 * Lightweight Google Places autocomplete input for territory checking.
 * Only shows the search input + suggestion dropdown — no City/State/Zip fields.
 * When a suggestion is selected, parses zip/city and feeds it to territory check.
 */
function TerritoryInput({ value, onChange, onDisplayChange, onAddressParsed }: {
    value: string;
    onChange: (text: string) => void;           // called on typing — sets both display + postalCode
    onDisplayChange: (text: string) => void;    // called on suggestion select — sets display only
    onAddressParsed: (parsed: { street: string; city: string; state: string; zip: string; lat?: number | null; lng?: number | null }) => void;
}) {
    const [activeIndex, setActiveIndex] = useState(-1);

    const locationBias = typeof google !== 'undefined' && google.maps
        ? new google.maps.LatLngBounds({ lat: 42.00, lng: -71.60 }, { lat: 42.50, lng: -70.667 })
        : undefined;

    const { ready, suggestions: { loading, status, data }, setValue: setSearchValue, clearSuggestions } = usePlacesAutocomplete({
        debounce: 200, cache: 60,
        requestOptions: { componentRestrictions: { country: ['us'] }, ...(locationBias && { locationBias }) },
    });

    const suggestions = useMemo(
        () => (data || []).slice(0, 6).map((item: google.maps.places.AutocompletePrediction) => ({ place_id: item.place_id, description: item.description })),
        [data]
    );

    function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
        const next = e.target.value;
        onChange(next);
        // Only trigger Google after first space (word + space gate)
        const hasSpace = /\S+\s/.test(next);
        setSearchValue(next, hasSpace);
        if (!hasSpace) { clearSuggestions(); setActiveIndex(-1); }
    }

    const selectSuggestion = useCallback((item: { place_id: string; description: string }) => {
        clearSuggestions(); setActiveIndex(-1);
        const parsed = parseDescription(item.description);
        // Update display to full address text (does NOT set postalCode)
        onDisplayChange(item.description);
        setSearchValue(item.description, false);
        // Feed parsed address to wizard — this sets postalCode to zip/city for territory check
        onAddressParsed(parsed);
    }, [clearSuggestions, onDisplayChange, setSearchValue, onAddressParsed]);

    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (!suggestions.length) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, suggestions.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)); }
        else if (e.key === 'Enter' && activeIndex >= 0 && activeIndex < suggestions.length) { e.preventDefault(); selectSuggestion(suggestions[activeIndex]); }
        else if (e.key === 'Escape') { clearSuggestions(); setActiveIndex(-1); }
    }

    const showDropdown = (loading || status === 'OK') && (loading || suggestions.length > 0);

    return (
        <div className="relative">
            <Input
                id="wz-territory"
                value={value}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                disabled={!ready}
                placeholder="e.g. 02101, Boston, or 123 Main St"
                autoComplete="off"
                maxLength={100}
            />
            {showDropdown && (
                <div role="listbox" className="absolute z-50 mt-1 w-full rounded-md border border-gray-200 bg-[#f3f3f5] shadow-md overflow-hidden">
                    {loading && <div className="px-3 py-2 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading…</div>}
                    {!loading && suggestions.map((item, idx) => (
                        <div
                            key={`${item.place_id}-${idx}`}
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

export function WizardStep1(s: WizardState) {
    const territoryBadge = (
        <>
            {s.territoryLoading && <span className="ml-2 text-xs animate-pulse" style={{ color: 'var(--blanc-ink-3)' }}>Checking…</span>}
            {s.zipExists && (
                <Badge variant="default" className="bg-green-600 ml-2 text-[10px]">
                    ✓ {s.zipArea || s.territoryResult?.service_territory?.name || 'In service area'}
                </Badge>
            )}
            {s.territoryError && !s.territoryLoading && (
                <Badge variant="destructive" className="ml-2 text-[10px]">
                    ✗ {s.territoryError}
                </Badge>
            )}
        </>
    );

    return (
        <div className="wizard__body">
            <div className="wizard__section-title" style={{ display: 'inline-flex', alignItems: 'center' }}>
                Territory Check{territoryBadge}
            </div>
            <div className="wizard__field" style={{ marginBottom: 16 }}>
                <Label htmlFor="wz-territory">Address, Zip Code, or City *</Label>
                <TerritoryInput
                    value={s.territoryQuery}
                    onChange={(text) => {
                        s.setTerritoryQuery(text);
                        // Raw typing goes directly to territory check (zip or city name)
                        s.setPostalCode(text);
                    }}
                    onDisplayChange={(text) => {
                        // Only update display text, NOT postalCode (onAddressParsed handles that)
                        s.setTerritoryQuery(text);
                    }}
                    onAddressParsed={(parsed) => {
                        // Fill address fields for Step 4
                        s.setStreetAddress(parsed.street);
                        s.setCity(parsed.city);
                        s.setState(parsed.state);
                        // postalCode is dual-purpose: territory check query + zip in Step4
                        // If we have a real zip, use it (works for both purposes)
                        // If no zip, use city for territory check — but matchedZip will be
                        // used for the actual zip field in payloads (see CreateLeadJobWizard)
                        s.setPostalCode(parsed.zip || parsed.city || '');
                        if (parsed.lat != null && parsed.lng != null) s.setCoords({ lat: parsed.lat, lng: parsed.lng });
                    }}
                />
            </div>
            <div className="wizard__section-title" style={{ marginTop: 18 }}>Customer</div>
            <div className="wizard__row">
                <div className="wizard__field wizard__field--wide"><Label htmlFor="wz-fname">First Name</Label><Input id="wz-fname" value={s.firstName} onChange={(e) => s.setFirstName(e.target.value)} placeholder="John" /></div>
                <div className="wizard__field wizard__field--wide"><Label htmlFor="wz-lname">Last Name</Label><Input id="wz-lname" value={s.lastName} onChange={(e) => s.setLastName(e.target.value)} placeholder="Doe" /></div>
            </div>
            <div className="wizard__row">
                <div className="wizard__field wizard__field--wide"><Label htmlFor="wz-phone">Phone</Label><PhoneInput id="wz-phone" value={s.phoneNumber} onChange={s.setPhoneNumber} /></div>
                <div className="wizard__field wizard__field--wide"><Label htmlFor="wz-email">Email</Label><Input id="wz-email" type="email" value={s.email} onChange={(e) => s.setEmail(e.target.value)} placeholder="email@example.com" /></div>
            </div>
        </div>
    );
}
