import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PulseContactBar, type PulseContactBarProps } from './PulseContactBar';
import { buildContactJobsUrl } from './contactJobsNavigation';
import pageSource from '../../pages/PulsePage.tsx?raw';

function props(overrides: Partial<PulseContactBarProps> = {}): PulseContactBarProps {
    return {
        name: 'Jane Doe',
        address: { street: '7 Main St', cityLine: 'Boston, MA' },
        phone: null,
        contactId: 731,
        canCall: false,
        hasEmail: false,
        emailConnected: false,
        showNotes: false,
        openCount: 0,
        onText: vi.fn(),
        onEmail: vi.fn(),
        onOpenNotes: vi.fn(),
        onOpenLeadsJobs: vi.fn(),
        onExpand: vi.fn(),
        ...overrides,
    };
}

interface IdentityElementProps {
    className?: string;
    role?: string;
    tabIndex?: number;
    onClick?: () => void;
    onKeyDown?: (event: { key: string; preventDefault: () => void }) => void;
}

interface ExpandElementProps {
    label?: string;
    onClick?: () => void;
}

type InspectableElement = React.ReactElement<Record<string, unknown>>;

function identityFrom(componentProps: PulseContactBarProps): React.ReactElement<IdentityElementProps> {
    const bar = PulseContactBar(componentProps);
    const children = React.Children.toArray(bar.props.children) as InspectableElement[];
    const identity = children.find(child => String(child.props.className).includes('pulse-contact-bar-identity'));
    if (!identity) throw new Error('Contact identity block not found');
    return identity as React.ReactElement<IdentityElementProps>;
}

describe('TECH-CONTACT-JOBS-001 — Pulse contact navigation', () => {
    it('builds an exact contact URL and omits contact_id when no contact exists', () => {
        expect(buildContactJobsUrl('Jane Doe', 731)).toBe('/jobs?search=Jane%20Doe&contact_id=731');
        expect(buildContactJobsUrl('Anonymous Caller', null)).toBe('/jobs?search=Anonymous%20Caller');
    });

    it('gates the Jobs call site on missing contacts.view without adding phone data', () => {
        expect(pageSource).toContain('canOpenCard={canViewContacts}');
        expect(pageSource).toMatch(/onOpenJobs=\{!canViewContacts[\s\S]*?buildContactJobsUrl\(contactName, p\.contact\?\.id\)/);
        expect(pageSource).not.toMatch(/buildContactJobsUrl\([^)]*phone/);
    });

    it('makes the technician identity a mouse and keyboard Jobs target', () => {
        const onOpenJobs = vi.fn();
        const componentProps = props({ canOpenCard: false, onOpenJobs });
        const identity = identityFrom(componentProps);

        expect(identity.props.role).toBe('button');
        expect(identity.props.tabIndex).toBe(0);
        identity.props.onClick?.();
        identity.props.onKeyDown?.({ key: 'Enter', preventDefault: vi.fn() });
        identity.props.onKeyDown?.({ key: ' ', preventDefault: vi.fn() });
        expect(onOpenJobs).toHaveBeenCalledTimes(3);

        const markup = renderToStaticMarkup(<PulseContactBar {...componentProps} />);
        expect(markup).toContain('pulse-contact-bar-jobs-chevron');
        expect(markup).not.toMatch(/\d{3}[- .]\d{3}/);
    });

    it('keeps contacts.view on the contact-panel path without Jobs navigation', () => {
        const onOpenJobs = vi.fn();
        const onExpand = vi.fn();
        const componentProps = props({ canOpenCard: true, onOpenJobs, onExpand });
        const bar = PulseContactBar(componentProps);
        const children = React.Children.toArray(bar.props.children) as InspectableElement[];
        const identity = identityFrom(componentProps);
        const expand = children.find(child => child.props.label === 'Open full contact card') as
            React.ReactElement<ExpandElementProps> | undefined;

        expect(identity.props.role).toBeUndefined();
        expect(identity.props.onClick).toBeUndefined();
        expect(expand?.props.onClick).toBe(onExpand);
        expand?.props.onClick?.();
        expect(onExpand).toHaveBeenCalledOnce();
        expect(onOpenJobs).not.toHaveBeenCalled();
    });
});
