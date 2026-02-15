/// <reference types="google.maps" />
import React, { useCallback, useEffect, useMemo, useState } from "react";
import usePlacesAutocomplete, { getDetails } from "use-places-autocomplete";

import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "./ui/select";
import { Checkbox } from "./ui/checkbox";
import { Loader2 } from "lucide-react";

/* Simple spinner */
function Spinner() {
    return <Loader2 className="size-4 animate-spin" />;
}

/* ─── Constants ───────────────────────────────────────────────── */

const US_STATES = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
] as const;

export interface AddressFields {
    street: string;
    apt: string;
    city: string;
    state: string;
    zip: string;
}

export const EMPTY_ADDRESS: AddressFields = { street: "", apt: "", city: "", state: "", zip: "" };

/* ─── Helpers ─────────────────────────────────────────────────── */

function hasFirstSpaceGate(value: string): boolean {
    const s = value.replace(/^\s+/, "");
    return /\S+\s/.test(s);
}

/** Extract structured address fields from Place Details result */
function parseAddressComponents(
    components: google.maps.GeocoderAddressComponent[]
): AddressFields {
    let streetNumber = "";
    let route = "";
    let city = "";
    let state = "";
    let zip = "";

    for (const c of components) {
        const t = c.types[0];
        if (t === "street_number") streetNumber = c.long_name;
        else if (t === "route") route = c.long_name;
        else if (t === "locality") city = c.long_name;
        else if (t === "sublocality_level_1" && !city) city = c.long_name;
        else if (t === "administrative_area_level_1") state = c.short_name;
        else if (t === "postal_code") zip = c.long_name;
    }

    return {
        street: [streetNumber, route].filter(Boolean).join(" "),
        apt: "",
        city,
        state,
        zip,
    };
}

/** Parse address from Autocomplete description text */
function parseDescription(desc: string): AddressFields {
    const cleaned = desc.replace(/,\s*(USA|United States)$/i, "").trim();
    const parts = cleaned.split(",").map((p) => p.trim());

    if (parts.length < 2) {
        return { ...EMPTY_ADDRESS, street: cleaned };
    }

    const street = parts[0];
    const city = parts[1];
    const stateZipStr = parts[2] || "";
    const stateZipMatch = stateZipStr.match(/^([A-Z]{2})(?:\s+(\d{5}(?:-\d{4})?))?$/);

    const state = stateZipMatch ? stateZipMatch[1] : stateZipStr;
    const zip = stateZipMatch?.[2] || "";

    return { street, apt: "", city, state, zip };
}

type SuggestionItem = {
    place_id?: string;
    description: string;
};

/* ─── Props ───────────────────────────────────────────────────── */

interface AddressAutocompleteProps {
    /** Current address value */
    value: AddressFields;
    /** Called when any field changes */
    onChange: (fields: AddressFields) => void;
    /** Optional id prefix for inputs (default: "addr") */
    idPrefix?: string;
    /** Optional label for street field (default: "Street Address") */
    streetLabel?: string;
    /** Optional header content (e.g. <h3>Address</h3>). Checkbox renders right-aligned next to it. */
    header?: React.ReactNode;
    /** Initial state of Place Details checkbox (default: false) */
    defaultUseDetails?: boolean;
}

/* ─── Component ───────────────────────────────────────────────── */

export function AddressAutocomplete({
    value: address,
    onChange,
    idPrefix = "addr",
    streetLabel = "Street Address",
    header,
    defaultUseDetails = false,
}: AddressAutocompleteProps) {
    const [gateReady, setGateReady] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const [detailsLoading, setDetailsLoading] = useState(false);
    const [useDetails, setUseDetails] = useState(defaultUseDetails);
    const [cyrillicWarning, setCyrillicWarning] = useState(false);

    const {
        ready,
        value: searchValue,
        suggestions: { loading, status, data },
        setValue: setSearchValue,
        clearSuggestions,
    } = usePlacesAutocomplete({
        debounce: 200,
        cache: 60,
        requestOptions: {
            componentRestrictions: { country: ["us"] },
            locationBias: new google.maps.LatLngBounds(
                { lat: 42.00, lng: -71.60 },
                { lat: 42.50, lng: -70.667 },
            ),
        },
    });

    // Keep search input in sync with street value from props
    useEffect(() => {
        // Only sync when not actively searching
        if (!gateReady && address.street !== searchValue) {
            setSearchValue(address.street, false);
        }
    }, [address.street]); // eslint-disable-line react-hooks/exhaustive-deps

    const suggestions = useMemo(() => {
        return (data || []).slice(0, 8).map((item: google.maps.places.AutocompletePrediction) => ({
            place_id: item.place_id,
            description: item.description,
        })) as SuggestionItem[];
    }, [data]);

    /* ─── Handlers ──────────────────────────────────────────────── */

    function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
        const next = e.target.value;

        // Cyrillic detection
        const hasCyrillic = /[\u0400-\u04FF]/.test(next);
        setCyrillicWarning(hasCyrillic);
        if (hasCyrillic) {
            clearSuggestions();
            setSearchValue(next, false);
            onChange({ ...address, street: next });
            return;
        }

        const gateNow = hasFirstSpaceGate(next);

        if (!gateNow) {
            setGateReady(false);
            setActiveIndex(-1);
            clearSuggestions();
            setSearchValue(next, false);
            onChange({ ...address, street: next });
            return;
        }

        if (!gateReady) setGateReady(true);
        setSearchValue(next, true);
        onChange({ ...address, street: next });
    }

    const selectSuggestion = useCallback(
        async (item: SuggestionItem) => {
            clearSuggestions();
            setActiveIndex(-1);
            setGateReady(false);

            if (!item.place_id || !useDetails) {
                const parsed = parseDescription(item.description);
                onChange(parsed);
                setSearchValue(parsed.street, false);
                return;
            }

            // Use Place Details API for better accuracy
            setSearchValue(item.description, false);
            setDetailsLoading(true);
            try {
                const result = await getDetails({
                    placeId: item.place_id,
                    fields: ["address_components"],
                });

                if (
                    result &&
                    typeof result === "object" &&
                    "address_components" in result &&
                    result.address_components
                ) {
                    const parsed = parseAddressComponents(result.address_components);
                    onChange(parsed);
                    setSearchValue(parsed.street, false);
                } else {
                    const parsed = parseDescription(item.description);
                    onChange(parsed);
                    setSearchValue(parsed.street, false);
                }
            } catch (err) {
                console.error("Place Details error:", err);
                const parsed = parseDescription(item.description);
                onChange(parsed);
                setSearchValue(parsed.street, false);
            } finally {
                setDetailsLoading(false);
            }
        },
        [setSearchValue, clearSuggestions, onChange, useDetails]
    );

    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (!suggestions.length) return;

        if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((i) => Math.max(i - 1, 0));
        } else if (e.key === "Enter") {
            if (activeIndex >= 0 && activeIndex < suggestions.length) {
                e.preventDefault();
                selectSuggestion(suggestions[activeIndex]);
            }
        } else if (e.key === "Escape") {
            clearSuggestions();
            setActiveIndex(-1);
        }
    }

    function handleFieldChange(field: keyof AddressFields, val: string) {
        onChange({ ...address, [field]: val });
    }

    const showDropdown =
        gateReady && (loading || status === "OK") && (loading || suggestions.length > 0);

    /* ─── Render ────────────────────────────────────────────────── */

    return (
        <div className="space-y-3">
            {/* Header row: heading (left) + Place Details checkbox (right) */}
            <div className="flex items-center justify-between">
                <div>{header}</div>
                <div className="flex items-center gap-2">
                    <Checkbox
                        id={`${idPrefix}-use-details`}
                        checked={useDetails}
                        onCheckedChange={(checked: boolean) => setUseDetails(checked)}
                    />
                    <Label htmlFor={`${idPrefix}-use-details`}>
                        <span className="text-xs text-muted-foreground">
                            Place Details API
                            <span className="text-[10px] ml-1 opacity-60">(more precise)</span>
                        </span>
                    </Label>
                </div>
            </div>

            {/* ── Street Address (search + display) */}
            <div className="relative">
                <Label htmlFor={`${idPrefix}-street`} className="mb-1.5">
                    {streetLabel}
                </Label>

                <Input
                    id={`${idPrefix}-street`}
                    value={searchValue}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    onFocus={(e) => {
                        const len = e.target.value.length;
                        e.target.setSelectionRange(len, len);
                    }}
                    disabled={!ready}
                    placeholder="Start typing address…"
                    autoComplete="off"
                />

                {!ready && (
                    <div className="mt-1.5 flex items-center gap-1.5">
                        <Spinner />
                        <span className="text-xs text-muted-foreground">Loading Google Maps…</span>
                    </div>
                )}

                {cyrillicWarning && (
                    <div className="absolute z-50 mt-1 w-full rounded-md border border-amber-300 bg-amber-50 shadow-md px-3 py-2 text-sm text-amber-800">
                        ⚠️ English only — please delete Cyrillic characters
                    </div>
                )}

                {showDropdown && !cyrillicWarning && (
                    <div
                        role="listbox"
                        className="absolute z-50 mt-1 w-full rounded-md border border-gray-200 bg-[#f3f3f5] shadow-md overflow-hidden"
                    >
                        {loading && (
                            <div className="px-3 py-2 flex items-center gap-2 text-sm text-muted-foreground">
                                <Spinner />
                                Loading…
                            </div>
                        )}

                        {!loading &&
                            suggestions.map((item, idx) => (
                                <div
                                    key={`${item.place_id || item.description}-${idx}`}
                                    role="option"
                                    aria-selected={idx === activeIndex}
                                    onMouseDown={(ev) => {
                                        ev.preventDefault();
                                        selectSuggestion(item);
                                    }}
                                    onMouseEnter={() => setActiveIndex(idx)}
                                    className={`cursor-pointer px-3 py-2 text-sm transition-colors
                                        ${idx === activeIndex
                                            ? "bg-accent text-accent-foreground"
                                            : "hover:bg-accent/50"
                                        }`}
                                >
                                    {item.description}
                                </div>
                            ))}
                    </div>
                )}
            </div>

            {/* ── Loading indicator */}
            {detailsLoading && (
                <div className="flex items-center gap-2">
                    <Spinner />
                    <span className="text-xs text-muted-foreground">Loading address details…</span>
                </div>
            )}

            {/* ── City / Apt / State / Zip row */}
            <div className="grid grid-cols-[2fr_1fr_72px_1fr] gap-3">
                <div className="space-y-1.5 min-w-0">
                    <Label htmlFor={`${idPrefix}-city`}>City</Label>
                    <Input
                        id={`${idPrefix}-city`}
                        value={address.city}
                        onChange={(e) => handleFieldChange("city", e.target.value)}
                        placeholder="Boston"
                    />
                </div>

                <div className="space-y-1.5 min-w-0">
                    <Label htmlFor={`${idPrefix}-apt`}>Apt/Unit</Label>
                    <Input
                        id={`${idPrefix}-apt`}
                        value={address.apt}
                        onChange={(e) => handleFieldChange("apt", e.target.value)}
                        placeholder="4B"
                    />
                </div>

                <div className="space-y-1.5">
                    <Label>State</Label>
                    <Select
                        value={address.state}
                        onValueChange={(val: string) => handleFieldChange("state", val)}
                    >
                        <SelectTrigger className="px-2 bg-[#f3f3f5]">
                            <SelectValue placeholder="ST" />
                        </SelectTrigger>
                        <SelectContent>
                            {US_STATES.map((st) => (
                                <SelectItem key={st} value={st}>
                                    {st}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="space-y-1.5 min-w-0">
                    <Label htmlFor={`${idPrefix}-zip`}>Zip</Label>
                    <Input
                        id={`${idPrefix}-zip`}
                        value={address.zip}
                        onChange={(e) => handleFieldChange("zip", e.target.value)}
                        placeholder="02101"
                    />
                </div>
            </div>
        </div>
    );
}
