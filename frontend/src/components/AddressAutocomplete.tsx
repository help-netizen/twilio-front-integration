/// <reference types="google.maps" />
import React, { useCallback, useMemo, useState } from "react";
import usePlacesAutocomplete, { getDetails } from "use-places-autocomplete";

import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Checkbox } from "./ui/checkbox";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "./ui/select";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "./ui/card";
import { MapPin, Loader2 } from "lucide-react";

/* Simple spinner using Lucide Loader2 icon */
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

interface AddressFields {
    street: string;
    apt: string;
    city: string;
    state: string;
    zip: string;
}

const EMPTY_ADDRESS: AddressFields = { street: "", apt: "", city: "", state: "", zip: "" };

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

/* ─── Component ───────────────────────────────────────────────── */

export function AddressAutocomplete() {
    const [gateReady, setGateReady] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const [address, setAddress] = useState<AddressFields>(EMPTY_ADDRESS);
    const [detailsLoading, setDetailsLoading] = useState(false);
    const [useDetails, setUseDetails] = useState(false);

    const {
        ready,
        value,
        suggestions: { loading, status, data },
        setValue,
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

    const suggestions = useMemo(() => {
        return (data || []).slice(0, 8).map((item: google.maps.places.AutocompletePrediction) => ({
            place_id: item.place_id,
            description: item.description,
        })) as SuggestionItem[];
    }, [data]);

    /* ─── Handlers ──────────────────────────────────────────────── */

    function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
        const next = e.target.value;
        const gateNow = hasFirstSpaceGate(next);

        if (!gateNow) {
            setGateReady(false);
            setActiveIndex(-1);
            clearSuggestions();
            setValue(next, false);
            return;
        }

        if (!gateReady) setGateReady(true);
        setValue(next, true);
    }

    const selectSuggestion = useCallback(
        async (item: SuggestionItem) => {
            clearSuggestions();
            setActiveIndex(-1);

            if (!useDetails) {
                const parsed = parseDescription(item.description);
                setAddress(parsed);
                setValue(parsed.street, false);
                return;
            }

            if (!item.place_id) {
                const parsed = parseDescription(item.description);
                setAddress(parsed);
                setValue(parsed.street, false);
                return;
            }

            // Temporarily show full description while loading details
            setValue(item.description, false);
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
                    setAddress(parsed);
                    setValue(parsed.street, false);
                } else {
                    // Fallback to description parsing
                    const parsed = parseDescription(item.description);
                    setAddress(parsed);
                    setValue(parsed.street, false);
                }
            } catch (err) {
                console.error("Place Details error:", err);
                const parsed = parseDescription(item.description);
                setAddress(parsed);
                setValue(parsed.street, false);
            } finally {
                setDetailsLoading(false);
            }
        },
        [setValue, clearSuggestions, useDetails]
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
        setAddress((prev) => ({ ...prev, [field]: val }));
    }

    const showDropdown =
        gateReady && (loading || status === "OK") && (loading || suggestions.length > 0);

    /* ─── Render ────────────────────────────────────────────────── */

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="flex size-10 items-center justify-center rounded-lg bg-gray-100 text-gray-600">
                            <MapPin className="size-5" />
                        </div>
                        <div>
                            <CardTitle>Address Autocomplete</CardTitle>
                            <CardDescription>Google Places address search</CardDescription>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Checkbox
                            id="use-details"
                            checked={useDetails}
                            onCheckedChange={(checked: boolean) => setUseDetails(checked)}
                        />
                        <Label htmlFor="use-details">
                            <span className="text-xs text-muted-foreground">
                                Place Details API
                                <span className="text-[10px] ml-1 opacity-60">(increase precise)</span>
                            </span>
                        </Label>
                    </div>
                </div>
            </CardHeader>

            <CardContent className="space-y-4">
                {/* ── Street Address (search + display) ────────────── */}
                <div className="relative">
                    <Label htmlFor="address-input" className="mb-1.5">
                        Street Address
                    </Label>

                    <Input
                        id="address-input"
                        value={value}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                            handleInputChange(e);
                            // Keep address.street in sync with typed value
                            setAddress((prev) => ({ ...prev, street: e.target.value }));
                        }}
                        onKeyDown={handleKeyDown}
                        disabled={!ready}
                        placeholder="Start typing: '12 Main St ...'"
                        autoComplete="off"
                    />

                    {!ready && (
                        <div className="mt-1.5 flex items-center gap-1.5">
                            <Spinner />
                            <span className="text-xs text-muted-foreground">Loading Google Maps…</span>
                        </div>
                    )}

                    {showDropdown && (
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

                {/* ── Loading indicator ─────────────────────────────── */}
                {detailsLoading && (
                    <div className="flex items-center gap-2">
                        <Spinner />
                        <span className="text-xs text-muted-foreground">Loading address details…</span>
                    </div>
                )}

                {/* ── Address fields ───────────────────────────────── */}
                <div className="flex flex-col sm:flex-row gap-3">

                    {/* City — widest */}
                    <div className="flex-[2] space-y-1.5 min-w-0">
                        <Label htmlFor="field-city">City</Label>
                        <Input
                            id="field-city"
                            value={address.city}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleFieldChange("city", e.target.value)}
                            placeholder="Boston"
                        />
                    </div>

                    {/* Apt/Unit/Floor — half-width */}
                    <div className="flex-1 space-y-1.5 min-w-0">
                        <Label htmlFor="field-apt">Apt/Unit</Label>
                        <Input
                            id="field-apt"
                            value={address.apt}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleFieldChange("apt", e.target.value)}
                            placeholder="4B"
                        />
                    </div>

                    {/* State — compact */}
                    <div className="w-[72px] shrink-0 space-y-1.5">
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

                    {/* Zip Code */}
                    <div className="flex-1 space-y-1.5 min-w-0">
                        <Label htmlFor="field-zip">Zip</Label>
                        <Input
                            id="field-zip"
                            value={address.zip}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleFieldChange("zip", e.target.value)}
                            placeholder="02101"
                        />
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
