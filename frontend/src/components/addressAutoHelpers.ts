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
        return { ...EMPTY_ADDRESS, street: cleaned };
    }

    const street = parts[0];
    const cityPart = parts[1];
    const stateZipStr = parts[2] || "";
    const stateZipMatch = stateZipStr.match(/^([A-Z]{2})(?:\s+(\d{5}(?:-\d{4})?))?$/);

    const statePart = stateZipMatch ? stateZipMatch[1] : stateZipStr;
    const zipPart = stateZipMatch?.[2] || "";

    return { street, apt: "", city: cityPart, state: statePart, zip: zipPart };
}
