/**
 * onboardingApi — ONBTEL-001 Part A: onboarding checklist (GET-only).
 *
 * Single endpoint: GET /api/onboarding/checklist (tenant_admin only; 403 for
 * other roles). The checklist has NO mutation endpoints — item completion is
 * derived server-side and `completed_at` is fixed write-once inside the GET.
 */
import { authedFetch } from './apiClient';

export interface OnboardingChecklistCta {
    label: string;
    path: string;
}

export interface OnboardingChecklistItem {
    key: string;
    title: string;
    description: string;
    done: boolean;
    cta: OnboardingChecklistCta;
    est_minutes: number;
    done_note: string;
}

export interface OnboardingChecklistProgress {
    done: number;
    total: number;
}

export interface OnboardingChecklistTrial {
    active: true;
    days_left: number;
    trial_ends_at: string;
}

export interface OnboardingChecklist {
    visible: boolean;
    completed_at: string | null;
    progress: OnboardingChecklistProgress;
    trial: OnboardingChecklistTrial | null;
    items: OnboardingChecklistItem[];
}

export async function fetchOnboardingChecklist(): Promise<OnboardingChecklist> {
    const res = await authedFetch('/api/onboarding/checklist', {
        headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Request failed: ${res.status}`);
    }
    const data: { ok: boolean; checklist: OnboardingChecklist } = await res.json();
    return data.checklist;
}
