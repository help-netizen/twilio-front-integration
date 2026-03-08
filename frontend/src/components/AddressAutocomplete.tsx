/// <reference types="google.maps" />
import React, { useCallback, useEffect, useMemo, useState } from "react";
import usePlacesAutocomplete, { getDetails } from "use-places-autocomplete";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Checkbox } from "./ui/checkbox";
import { Loader2, MapPin } from "lucide-react";
import type { SavedAddress } from "../services/contactsApi";
import { US_STATES, EMPTY_ADDRESS, hasFirstSpaceGate, parseAddressComponents, parseDescription } from "./addressAutoHelpers";
import type { AddressFields, SuggestionItem } from "./addressAutoHelpers";

export type { AddressFields, SuggestionItem };
export { EMPTY_ADDRESS };

function Spinner() { return <Loader2 className="size-4 animate-spin" />; }

interface AddressAutocompleteProps { value: AddressFields; onChange: (fields: AddressFields) => void; idPrefix?: string; streetLabel?: string; header?: React.ReactNode; defaultUseDetails?: boolean; savedAddresses?: SavedAddress[]; onSelectSaved?: (addressId: number) => void; }

export function AddressAutocomplete({ value: address, onChange, idPrefix = "addr", streetLabel = "Street Address", header, defaultUseDetails = false, savedAddresses = [], onSelectSaved }: AddressAutocompleteProps) {
    const [gateReady, setGateReady] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const [detailsLoading, setDetailsLoading] = useState(false);
    const [useDetails, setUseDetails] = useState(defaultUseDetails);
    const [cyrillicWarning, setCyrillicWarning] = useState(false);
    const [showSaved, setShowSaved] = useState(false);
    const hasSaved = savedAddresses.length > 0;

    const { ready, value: searchValue, suggestions: { loading, status, data }, setValue: setSearchValue, clearSuggestions } = usePlacesAutocomplete({ debounce: 200, cache: 60, requestOptions: { componentRestrictions: { country: ["us"] }, locationBias: new google.maps.LatLngBounds({ lat: 42.00, lng: -71.60 }, { lat: 42.50, lng: -70.667 }) } });

    useEffect(() => { if (!gateReady && address.street !== searchValue) setSearchValue(address.street, false); }, [address.street]); // eslint-disable-line react-hooks/exhaustive-deps

    const suggestions = useMemo(() => (data || []).slice(0, 8).map((item: google.maps.places.AutocompletePrediction) => ({ place_id: item.place_id, description: item.description })) as SuggestionItem[], [data]);

    function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
        const next = e.target.value;
        const hasCyrillic = /[\u0400-\u04FF]/.test(next);
        setCyrillicWarning(hasCyrillic);
        if (hasCyrillic) { clearSuggestions(); setSearchValue(next, false); onChange({ ...address, street: next }); return; }
        const gateNow = hasFirstSpaceGate(next);
        if (!gateNow) { setGateReady(false); setActiveIndex(-1); clearSuggestions(); setSearchValue(next, false); onChange({ ...address, street: next }); return; }
        if (!gateReady) setGateReady(true);
        setSearchValue(next, true); onChange({ ...address, street: next });
    }

    const selectSuggestion = useCallback(async (item: SuggestionItem) => {
        clearSuggestions(); setActiveIndex(-1); setGateReady(false);
        if (!item.place_id || !useDetails) { const parsed = parseDescription(item.description); onChange(parsed); setSearchValue(parsed.street, false); return; }
        setSearchValue(item.description, false); setDetailsLoading(true);
        try {
            const result = await getDetails({ placeId: item.place_id, fields: ["address_components", "geometry"] });
            if (result && typeof result === "object" && "address_components" in result && result.address_components) { const parsed = parseAddressComponents(result.address_components, result.geometry); onChange(parsed); setSearchValue(parsed.street, false); }
            else { const parsed = parseDescription(item.description); onChange(parsed); setSearchValue(parsed.street, false); }
        } catch (err) { console.error("Place Details error:", err); const parsed = parseDescription(item.description); onChange(parsed); setSearchValue(parsed.street, false); }
        finally { setDetailsLoading(false); }
    }, [setSearchValue, clearSuggestions, onChange, useDetails]);

    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (!suggestions.length) return;
        if (e.key === "ArrowDown") { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, suggestions.length - 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)); }
        else if (e.key === "Enter") { if (activeIndex >= 0 && activeIndex < suggestions.length) { e.preventDefault(); selectSuggestion(suggestions[activeIndex]); } }
        else if (e.key === "Escape") { clearSuggestions(); setActiveIndex(-1); }
    }

    function handleFieldChange(field: keyof AddressFields, val: string) { onChange({ ...address, [field]: val }); }
    function handleSelectSavedAddress(addr: SavedAddress) { const fields: AddressFields = { street: addr.street_line1, apt: addr.street_line2 || '', city: addr.city, state: addr.state, zip: addr.postal_code, lat: addr.lat, lng: addr.lng }; onChange(fields); setSearchValue(addr.street_line1, false); setShowSaved(false); clearSuggestions(); setGateReady(false); onSelectSaved?.(addr.id); }

    const showDropdown = gateReady && (loading || status === "OK") && (loading || suggestions.length > 0);

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between"><div>{header}</div><div className="flex items-center gap-2"><Checkbox id={`${idPrefix}-use-details`} checked={useDetails} onCheckedChange={(checked: boolean) => setUseDetails(checked)} /><Label htmlFor={`${idPrefix}-use-details`}><span className="text-xs text-muted-foreground">Place Details API<span className="text-[10px] ml-1 opacity-60">(more precise)</span></span></Label></div></div>
            <div className="flex gap-3">
                <div className="relative flex-1 min-w-0">
                    <Label htmlFor={`${idPrefix}-street`} className="mb-1.5">{streetLabel}</Label>
                    <Input id={`${idPrefix}-street`} value={searchValue} onChange={handleInputChange} onKeyDown={handleKeyDown} onFocus={(e) => { const input = e.target; requestAnimationFrame(() => { const len = input.value.length; input.setSelectionRange(len, len); }); if (hasSaved) setShowSaved(true); }} onBlur={() => setTimeout(() => setShowSaved(false), 200)} disabled={!ready} placeholder="Start typing address…" autoComplete="off" />
                    {!ready && <div className="mt-1.5 flex items-center gap-1.5"><Spinner /><span className="text-xs text-muted-foreground">Loading Google Maps…</span></div>}
                    {cyrillicWarning && <div className="absolute z-50 mt-1 w-full rounded-md border border-amber-300 bg-amber-50 shadow-md px-3 py-2 text-sm text-amber-800">⚠️ English only — please delete Cyrillic characters</div>}
                    {(showDropdown || (showSaved && hasSaved)) && !cyrillicWarning && (
                        <div role="listbox" className="absolute z-50 mt-1 w-full rounded-md border border-gray-200 bg-[#f3f3f5] shadow-md overflow-hidden">
                            {showSaved && hasSaved && (<><div className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider bg-[#ebedf0]">Saved addresses</div>{savedAddresses.map(addr => <div key={addr.id} role="option" aria-selected={false} onMouseDown={ev => { ev.preventDefault(); handleSelectSavedAddress(addr); }} className="cursor-pointer px-3 py-2 text-sm transition-colors hover:bg-accent/50 flex items-center gap-2"><MapPin className="size-3.5 text-indigo-500 shrink-0" /><span className="truncate">{addr.display}</span>{addr.is_primary && <span className="ml-auto text-[10px] font-medium text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">Primary</span>}</div>)}{showDropdown && <div className="border-t border-gray-200" />}</>)}
                            {loading && <div className="px-3 py-2 flex items-center gap-2 text-sm text-muted-foreground"><Spinner />Loading…</div>}
                            {!loading && suggestions.map((item, idx) => <div key={`${item.place_id || item.description}-${idx}`} role="option" aria-selected={idx === activeIndex} onMouseDown={ev => { ev.preventDefault(); selectSuggestion(item); }} onMouseEnter={() => setActiveIndex(idx)} className={`cursor-pointer px-3 py-2 text-sm transition-colors ${idx === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`}>{item.description}</div>)}
                        </div>
                    )}
                </div>
                <div className="space-y-1.5 w-[100px] shrink-0"><Label htmlFor={`${idPrefix}-apt`}>Apt/Unit</Label><Input id={`${idPrefix}-apt`} value={address.apt} onChange={e => handleFieldChange("apt", e.target.value)} placeholder="4B" /></div>
            </div>
            {detailsLoading && <div className="flex items-center gap-2"><Spinner /><span className="text-xs text-muted-foreground">Loading address details…</span></div>}
            <div className="grid grid-cols-[2fr_72px_1fr] gap-3">
                <div className="space-y-1.5 min-w-0"><Label htmlFor={`${idPrefix}-city`}>City</Label><Input id={`${idPrefix}-city`} value={address.city} onChange={e => handleFieldChange("city", e.target.value)} placeholder="Boston" /></div>
                <div className="space-y-1.5"><Label>State</Label><Select value={address.state} onValueChange={(val: string) => handleFieldChange("state", val)}><SelectTrigger className="px-2 bg-[#f3f3f5]"><SelectValue placeholder="ST" /></SelectTrigger><SelectContent>{US_STATES.map(st => <SelectItem key={st} value={st}>{st}</SelectItem>)}</SelectContent></Select></div>
                <div className="space-y-1.5 min-w-0"><Label htmlFor={`${idPrefix}-zip`}>Zip</Label><Input id={`${idPrefix}-zip`} value={address.zip} onChange={e => handleFieldChange("zip", e.target.value)} placeholder="02101" /></div>
            </div>
        </div>
    );
}
