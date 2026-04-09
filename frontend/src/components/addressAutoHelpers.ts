/// <reference types="google.maps" />

export const US_STATES = [
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
    lat?: number | null;
    lng?: number | null;
}

export const EMPTY_ADDRESS: AddressFields = { street: "", apt: "", city: "", state: "", zip: "", lat: null, lng: null };

export type SuggestionItem = {
    place_id?: string;
    description: string;
};

export function hasFirstSpaceGate(value: string): boolean {
    const s = value.replace(/^\s+/, "");
    return /\S+\s/.test(s);
}

/** Extract structured address fields from Place Details result */
export function parseAddressComponents(
    components: google.maps.GeocoderAddressComponent[],
    geometry?: google.maps.places.PlaceResult["geometry"]
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

    const lat = geometry?.location?.lat() ?? null;
    const lng = geometry?.location?.lng() ?? null;

    return { street: [streetNumber, route].filter(Boolean).join(" "), apt: "", city, state, zip, lat, lng };
}

/** Parse address from Autocomplete description text */
export function parseDescription(desc: string): AddressFields {
    const cleaned = desc.replace(/,\s*(USA|United States)$/i, "").trim();
    const parts = cleaned.split(",").map((p) => p.trim());

    if (parts.length < 2) {
        // Single part — could be a zip code or city name
        const zipOnly = cleaned.match(/^(\d{5}(?:-\d{4})?)$/);
        if (zipOnly) return { ...EMPTY_ADDRESS, zip: zipOnly[1] };
        return { ...EMPTY_ADDRESS, street: cleaned };
    }

    // Try to extract state+zip from the last meaningful part
    // Handles both "Street, City, ST 02062" (3 parts) and "City, ST 02062" (2 parts)
    const stateZipRe = /^([A-Z]{2})(?:\s+(\d{5}(?:-\d{4})?))?$/;

    if (parts.length >= 3) {
        // State+zip is always the LAST part, city is second-to-last, everything before is street
        // "123 Main St, Norwood, MA 02062" → street="123 Main St", city="Norwood", state="MA", zip="02062"
        // "US Fish & Wildlife, Everett Ave, Chelsea, MA" → street="US Fish & Wildlife, Everett Ave", city="Chelsea", state="MA"
        const last = parts[parts.length - 1];
        const match = last.match(stateZipRe);
        const cityPart = parts[parts.length - 2];
        const streetParts = parts.slice(0, parts.length - 2);
        return { street: streetParts.join(", "), apt: "", city: match ? cityPart : parts[parts.length - 2], state: match?.[1] || last, zip: match?.[2] || "" };
    }

    // 2 parts: could be "City, ST 02062" or "Street, City"
    const match = parts[1].match(stateZipRe);
    if (match) {
        // "Norwood, MA 02062" → city=Norwood, state=MA, zip=02062
        return { street: "", apt: "", city: parts[0], state: match[1], zip: match[2] || "" };
    }

    // "123 Main St, Norwood" → street + city
    return { street: parts[0], apt: "", city: parts[1], state: "", zip: "" };
}
