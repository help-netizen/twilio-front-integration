export interface SavedPaymentMethod {
    id: number;
    brand: string;
    last4: string;
    exp_month: number;
    exp_year: number;
}

export interface JobSavedPaymentMethods {
    due: number;
    cards: SavedPaymentMethod[];
}
