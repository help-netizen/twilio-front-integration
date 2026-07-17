export type Step = 1 | 2 | 3 | 4;

export const STEP_LABELS: Record<Step, string> = {
    1: 'Territory',
    2: 'Service',
    3: 'Schedule',
    4: 'Confirm',
};

export const DEFAULT_JOB_TYPES = ['COD Service', 'COD Repair', 'Warranty', 'INS Service', 'INS Repair'];

export interface WizardState {
    // Step 1
    territoryQuery: string; setTerritoryQuery: (v: string) => void;
    postalCode: string; setPostalCode: (v: string) => void;
    territoryResult: any; territoryLoading: boolean; territoryError: string;
    zipExists: boolean | null; zipArea: string; matchedZip: string; zipSource: string;
    zbLoading: boolean;
    firstName: string; setFirstName: (v: string) => void;
    lastName: string; setLastName: (v: string) => void;
    phoneNumber: string; setPhoneNumber: (v: string) => void;
    email: string; setEmail: (v: string) => void;
    // Step 2
    jobTypes: string[];
    jobType: string; setJobType: (v: string) => void;
    description: string; setDescription: (v: string) => void;
    duration: string; setDuration: (v: string) => void;
    price: string; setPrice: (v: string) => void;
    // Step 3
    selectedDate: string; setSelectedDate: (v: string) => void;
    timeslotDays: any[]; selectedTimeslot: any; setSelectedTimeslot: (v: any) => void;
    timeslotsLoading: boolean; timeslotsError: string;
    timeslotSkipped: boolean; setTimeslotSkipped: (v: boolean) => void;
    fetchTimeslots: () => void;
    showSkipConfirm: boolean; setShowSkipConfirm: (v: boolean) => void;
    // Step 4
    streetAddress: string; setStreetAddress: (v: string) => void;
    unit: string; setUnit: (v: string) => void;
    city: string; setCity: (v: string) => void;
    state: string; setState: (v: string) => void;
    coords: { lat: number; lng: number } | null; setCoords: (v: any) => void;
    submitting: boolean;
    handleCreate: (withJob: boolean) => void;
    setStep: (s: Step) => void;
}
