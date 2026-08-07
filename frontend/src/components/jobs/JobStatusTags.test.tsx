import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalJob } from '../../services/jobsApi';
import type { FsmAction } from '../../hooks/useFsmActions';

// FSM-JOB-ACTIONS-001 — the hardcoded job-status buttons (Complete / On the way / Start) and their
// /enroute /start /complete routes were removed in the Phase 4 cleanup. JobOpsSection now renders
// its status buttons purely from the per-company FSM's action-transitions (blanc:action + blanc:button).
// This suite proves the REPLACEMENT still works: FSM `button` actions render, non-button actions do
// not, and an empty action set renders no button row (the section itself still stands).

const state = vi.hoisted(() => ({
    actions: [] as FsmAction[],
    initialState: 'Submitted' as string | null,
    mutateAsync: vi.fn(),
}));

vi.mock('../../hooks/useFsmActions', () => ({
    useFsmActions: () => ({ data: state.actions }),
    useApplyTransition: () => ({ mutateAsync: state.mutateAsync, isPending: false }),
    useFsmStates: () => ({ data: { initialState: state.initialState, states: [] } }),
}));
vi.mock('../../hooks/useAuthz', () => ({
    useAuthz: () => ({ hasPermission: () => true, hasAnyPermission: () => true }),
}));
// Keep the render focused on the FSM button row; the RateMe block and ETA modal have their own deps.
vi.mock('./JobRateMeBlock', () => ({ JobRateMeBlock: () => null }));
vi.mock('./OnTheWayModal', () => ({ OnTheWayModal: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../ui/dropdown-menu', () => ({
    DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { JobOpsSection } from './JobStatusTags';

function action(overrides: Partial<FsmAction>): FsmAction {
    return {
        event: 'evt', target: 'Some State', label: 'Label', icon: null,
        confirm: false, confirmText: null, order: 1, roles: null,
        button: true, variant: 'primary', op: null, ...overrides,
    };
}

function job(overrides: Partial<LocalJob> = {}): LocalJob {
    return {
        id: 1545,
        serial_id: 1545,
        blanc_status: 'On the way',
        service_name: 'Refrigerator repair',
        assigned_techs: [],
        tags: [],
        ...overrides,
    } as LocalJob;
}

function render(j: LocalJob = job()) {
    return renderToStaticMarkup(
        <JobOpsSection
            job={j}
            allTags={[]}
            onTagsChange={vi.fn()}
            onCancel={vi.fn()}
            onNotified={vi.fn()}
        />,
    );
}

describe('JobOpsSection — FSM-driven status buttons (FSM-JOB-ACTIONS-001)', () => {
    beforeEach(() => {
        state.mutateAsync = vi.fn();
        state.initialState = 'Submitted';
        state.actions = [
            action({ event: 'go_on_the_way', target: 'On the way', label: 'On the way', icon: 'Navigation', order: 1, button: true, variant: 'primary', op: 'notify_on_the_way' }),
            action({ event: 'finish', target: 'Job is Done', label: 'Complete job', icon: 'CheckCircle2', order: 2, button: true, variant: 'success' }),
            // Corrective/terminal — flagged button:true but must stay dropdown-only, never a button.
            action({ event: 'cancel', target: 'Canceled', label: 'Cancel', order: 4, button: true, variant: 'danger' }),
            action({ event: 'reset', target: 'Submitted', label: 'Back to Submitted', order: 5, button: true, variant: 'secondary' }),
            // button:false → menu-only, must NOT surface as a prominent button.
            action({ event: 'note_only', target: 'Follow Up with Client', label: 'Menu Only Action', order: 3, button: false, variant: 'neutral' }),
        ];
    });

    it('renders a prominent button for each FSM action flagged blanc:button', () => {
        const html = render();
        expect(html).toContain('On the way');
        expect(html).toContain('Complete job');
    });

    it('does not render actions that are menu-only (button === false)', () => {
        const html = render();
        expect(html).not.toContain('Menu Only Action');
    });

    it('keeps Cancel and back-to-initial (Back to Submitted) out of the buttons — dropdown-only', () => {
        const html = render();
        expect(html).not.toContain('Back to Submitted');
        expect(html).not.toContain('Cancel');
        // forward actions still render as buttons
        expect(html).toContain('On the way');
        expect(html).toContain('Complete job');
    });

    it('renders no button row when the FSM offers no actions', () => {
        state.actions = [];
        const html = render();
        expect(html).not.toContain('Complete job');
        expect(html).not.toContain('On the way');
        // The section itself still renders (Tags eyebrow is always present).
        expect(html).toContain('Tags');
    });
});
