/**
 * SHEET-KEYBOARD-001 real-component harness.
 *
 * Mounts the production TaskFormDialog (mobile Radix-dialog sheet) and production
 * BottomSheet against a controllable fake VisualViewport. The self-test proves real
 * component wiring and geometry; it cannot create or certify an OS keyboard.
 *
 * Run:  npx vite --host 127.0.0.1 --port 3001
 * Open: http://127.0.0.1:3001/sheet-keyboard-harness.html at a viewport < 768px.
 */

import { useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import '../styles/tailwind.css';
import '../styles/design-system.css';
import { BottomSheet } from '../components/ui/BottomSheet';
import { OverlayStackProvider } from '../components/ui/OverlayStack';
import { TaskFormDialog } from '../components/tasks/TaskFormDialog';
import { Button } from '../components/ui/button';

type Check = { label: string; pass: boolean; detail: string };
type HarnessFailure = { title: string; detail: string };

interface HarnessRuntime {
    root: Root | null;
    consoleErrors: string[];
    consolePatched: boolean;
    errorListeners: Set<(message: string) => void>;
    originalConsoleError: Console['error'];
}

declare global {
    interface Window {
        __sheetKeyboardHarnessRuntime?: HarnessRuntime;
    }
}

const harnessRuntime: HarnessRuntime = window.__sheetKeyboardHarnessRuntime ?? {
    root: null,
    consoleErrors: [],
    consolePatched: false,
    errorListeners: new Set(),
    originalConsoleError: console.error.bind(console),
};
window.__sheetKeyboardHarnessRuntime = harnessRuntime;

function formatConsoleValue(value: unknown): string {
    if (value instanceof Error) return value.stack ?? value.message;
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

if (!harnessRuntime.consolePatched) {
    harnessRuntime.consolePatched = true;
    console.error = (...args: unknown[]) => {
        const message = args.map(formatConsoleValue).join(' ');
        harnessRuntime.consoleErrors.push(message);
        harnessRuntime.errorListeners.forEach(listener => listener(message));
        harnessRuntime.originalConsoleError(...args);
    };
}

class HarnessRunAbort extends Error {
    readonly title: string;

    constructor(title: string, message: string) {
        super(message);
        this.title = title;
    }
}

function consoleFailure(): HarnessFailure {
    return {
        title: 'HARNESS ABORTED — CONSOLE ERROR',
        detail: harnessRuntime.consoleErrors.join('\n'),
    };
}

function assertNoConsoleErrors(): void {
    if (harnessRuntime.consoleErrors.length > 0) {
        const failure = consoleFailure();
        throw new HarnessRunAbort(failure.title, failure.detail);
    }
}

const REAL_DEVICE_ONLY_CHECKS = [
    {
        label: 'TaskFormDialog tracks first-open keyboard geometry',
        reason: 'A desktop VisualViewport replacement does not reproduce an OS keyboard or its viewport transition.',
    },
    {
        label: 'Focused Description remains visible during the keyboard transition',
        reason: 'Visibility depends on the mobile browser keyboard, focus scrolling, and viewport animation acting together.',
    },
    {
        label: 'A visible focused field avoids unnecessary reveal scrolling',
        reason: 'Desktop focus scrolling is not equivalent to mobile OS-keyboard focus scrolling.',
    },
    {
        label: 'A covered active field invokes the shared reveal fallback',
        reason: 'The fallback depends on real focus, scroll-container, and keyboard geometry timing.',
    },
    {
        label: 'Focus zoom keeps the time field visible',
        reason: 'Desktop Chrome cannot reproduce iOS Safari focus zoom.',
    },
    {
        label: 'BottomSheet tracks a panned keyboard viewport',
        reason: 'A synthetic offsetTop does not reproduce browser panning during a real keyboard session.',
    },
    {
        label: 'Restoring the keyboard viewport restores normal dialog geometry',
        reason: 'The desktop fake cannot certify the mobile browser keyboard-dismiss transition.',
    },
] as const;

class FakeVisualViewport extends EventTarget {
    width = window.innerWidth;
    height = window.innerHeight;
    offsetLeft = 0;
    offsetTop = 0;
    pageLeft = 0;
    pageTop = 0;
    scale = 1;

    setRect({ height, offsetTop, scale = 1 }: { height: number; offsetTop: number; scale?: number }) {
        const offsetChanged = this.offsetTop !== offsetTop;
        this.width = window.innerWidth;
        this.height = height;
        this.offsetTop = offsetTop;
        this.pageTop = offsetTop;
        this.scale = scale;
        this.dispatchEvent(new Event('resize'));
        if (offsetChanged) this.dispatchEvent(new Event('scroll'));
    }
}

const fakeViewport = new FakeVisualViewport();
Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: fakeViewport as unknown as VisualViewport,
});

const originalFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/tasks/assignees')) {
        return new Response(JSON.stringify({
            ok: true,
            data: { users: [{ id: 'harness-user', name: 'Harness User', email: 'harness@example.com' }] },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(input, init);
};

const TOP_GAP = 16;
const SETTLE_TIMEOUT_MS = 4000;

function delay(ms = 25): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, ms));
}

function findDialog(text: string): HTMLElement | null {
    return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
        .find(element => element.getAttribute('data-state') !== 'closed'
            && element.textContent?.includes(text)) ?? null;
}

function within(actual: number, expected: number, tolerance = 2): boolean {
    return Math.abs(actual - expected) <= tolerance;
}

async function waitFor(
    predicate: () => boolean,
    timeoutMs = SETTLE_TIMEOUT_MS,
    monitorConsole = true,
): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        if (monitorConsole) assertNoConsoleErrors();
        if (predicate()) return true;
        await delay();
    }
    if (monitorConsole) assertNoConsoleErrors();
    return predicate();
}

function describeElement(element: Element | Document | null): string {
    if (!element) return '<missing>';
    if (element === document) return 'document';
    const htmlElement = element as HTMLElement;
    const parts = [htmlElement.tagName.toLowerCase()];
    if (htmlElement.id) parts.push(`#${htmlElement.id}`);
    const role = htmlElement.getAttribute('role');
    if (role) parts.push(`[role="${role}"]`);
    const state = htmlElement.getAttribute('data-state');
    if (state) parts.push(`[data-state="${state}"]`);
    const type = htmlElement.getAttribute('type');
    if (type) parts.push(`[type="${type}"]`);
    const ariaLabel = htmlElement.getAttribute('aria-label');
    if (ariaLabel) parts.push(`[aria-label="${ariaLabel}"]`);
    if (htmlElement.style.zIndex) parts.push(`[style.zIndex="${htmlElement.style.zIndex}"]`);
    if (htmlElement.classList.contains('overflow-y-auto')) parts.push('.overflow-y-auto');
    return parts.join('');
}

function measurementDetail(
    element: Element | Document | null,
    coordinateSpace: string,
    measurement: string,
): string {
    return `element=${describeElement(element)}; space=${coordinateSpace}; `
        + `layoutViewport=${window.innerWidth}x${window.innerHeight}; `
        + `syntheticVisualViewport={top:${fakeViewport.offsetTop},height:${fakeViewport.height},scale:${fakeViewport.scale}}; `
        + measurement;
}

function expectedViewportGeometry() {
    const layoutHeight = Math.max(0, window.innerHeight);
    const visualTop = Math.min(Math.max(0, fakeViewport.offsetTop), layoutHeight);
    const visualHeight = Math.min(Math.max(0, fakeViewport.height), layoutHeight - visualTop);
    const visualBottom = visualTop + visualHeight;
    return {
        visualTop,
        visualBottom,
        bottomInset: Math.max(0, layoutHeight - visualBottom),
        usableHeight: Math.max(0, visualHeight - TOP_GAP),
    };
}

type PanelGeometryKind = 'dialog' | 'bottom-sheet';

function panelHasExpectedInlineGeometry(panel: HTMLElement, kind: PanelGeometryKind): boolean {
    const expected = expectedViewportGeometry();
    const inlineBottom = Number.parseFloat(panel.style.bottom);
    const extentMatches = kind === 'dialog'
        ? within(Number.parseFloat(panel.style.maxHeight), expected.usableHeight)
        : panel.style.height.includes(`${expected.usableHeight}px`);
    return panel.isConnected
        && panel.getAttribute('data-state') !== 'closed'
        && getComputedStyle(panel).position === 'fixed'
        && within(inlineBottom, expected.bottomInset)
        && extentMatches;
}

interface RectSnapshot {
    top: number;
    right: number;
    bottom: number;
    left: number;
    width: number;
    height: number;
}

interface PanelSettlement {
    panel: HTMLElement | null;
    settled: boolean;
    detail: string;
}

function snapshotRect(panel: HTMLElement): RectSnapshot {
    const rect = panel.getBoundingClientRect();
    return {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
    };
}

function sameRect(a: RectSnapshot, b: RectSnapshot): boolean {
    return Object.keys(a).every(key => (
        Math.abs(a[key as keyof RectSnapshot] - b[key as keyof RectSnapshot]) <= 0.01
    ));
}

function transformIsAtRest(transform: string): boolean {
    if (transform === 'none') return true;
    try {
        const matrix = new DOMMatrixReadOnly(transform);
        return within(matrix.m41, 0, 0.01) && within(matrix.m42, 0, 0.01);
    } catch {
        return false;
    }
}

function unsettledAnimations(panel: HTMLElement): Animation[] {
    return panel.getAnimations().filter(animation => (
        animation.pending
        || (animation.playState !== 'finished' && animation.playState !== 'idle')
    ));
}

function nextAnimationFrame(timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
        let complete = false;
        let timeoutId = 0;
        const frameId = window.requestAnimationFrame(() => {
            if (complete) return;
            complete = true;
            window.clearTimeout(timeoutId);
            resolve(true);
        });
        timeoutId = window.setTimeout(() => {
            if (complete) return;
            complete = true;
            window.cancelAnimationFrame(frameId);
            resolve(false);
        }, Math.max(1, timeoutMs));
    });
}

function panelStateDetail(panel: HTMLElement | null, kind: PanelGeometryKind): string {
    if (!panel) return 'panel=<missing>';
    const rect = snapshotRect(panel);
    const computed = getComputedStyle(panel);
    const animations = panel.getAnimations()
        .map(animation => `${animation.playState}${animation.pending ? '+pending' : ''}`)
        .join(',') || 'none';
    const inlineExtent = kind === 'dialog'
        ? `maxHeight=${panel.style.maxHeight || '<unset>'}`
        : `height=${panel.style.height || '<unset>'}`;
    return `panel=${describeElement(panel)}; position=${computed.position}; `
        + `inline bottom=${panel.style.bottom || '<unset>'}, ${inlineExtent}; `
        + `transform=${computed.transform}; animations=${animations}; `
        + `rect={top:${rect.top.toFixed(2)},right:${rect.right.toFixed(2)},bottom:${rect.bottom.toFixed(2)},`
        + `left:${rect.left.toFixed(2)},width:${rect.width.toFixed(2)},height:${rect.height.toFixed(2)}}`;
}

async function settlePanelGeometry(
    find: () => HTMLElement | null,
    kind: PanelGeometryKind,
): Promise<PanelSettlement> {
    const deadline = performance.now() + SETTLE_TIMEOUT_MS;
    const previous: { panel: HTMLElement | null; rect: RectSnapshot | null } = {
        panel: null,
        rect: null,
    };

    while (performance.now() < deadline) {
        assertNoConsoleErrors();
        const frameArrived = await nextAnimationFrame(Math.min(250, deadline - performance.now()));
        if (!frameArrived) {
            previous.panel = null;
            previous.rect = null;
            continue;
        }

        const panel = find();
        if (!panel
            || !panelHasExpectedInlineGeometry(panel, kind)
            || unsettledAnimations(panel).length > 0
            || !transformIsAtRest(getComputedStyle(panel).transform)) {
            previous.panel = null;
            previous.rect = null;
            continue;
        }

        const rect = snapshotRect(panel);
        if (previous.panel === panel && previous.rect && sameRect(previous.rect, rect)) {
            return {
                panel,
                settled: true,
                detail: measurementDetail(
                    panel,
                    'getBoundingClientRect layout-viewport CSS px; identical across consecutive animation frames',
                    `settled=true; ${panelStateDetail(panel, kind)}`,
                ),
            };
        }
        previous.panel = panel;
        previous.rect = rect;
    }

    const panel = find();
    return {
        panel,
        settled: false,
        detail: measurementDetail(
            panel,
            'getBoundingClientRect layout-viewport CSS px; bounded two-frame settlement',
            `SETTLEMENT TIMEOUT after ${SETTLE_TIMEOUT_MS}ms; ${panelStateDetail(panel, kind)}`,
        ),
    };
}

function Harness() {
    const [taskOpen, setTaskOpen] = useState(false);
    const [sheetOpen, setSheetOpen] = useState(false);
    const [checks, setChecks] = useState<Check[]>([]);
    const [running, setRunning] = useState(false);
    const [harnessFailure, setHarnessFailure] = useState<HarnessFailure | null>(null);

    const resetViewport = () => {
        fakeViewport.setRect({ height: window.innerHeight, offsetTop: 0, scale: 1 });
    };

    const resetOverlayState = async (scenario: string, monitorConsole = true) => {
        setSheetOpen(false);
        setTaskOpen(false);
        resetViewport();
        await nextAnimationFrame(250);

        const clean = await waitFor(() => {
            const dialogs = document.querySelectorAll('[role="dialog"]').length;
            const sheetBackdrops = Array.from(document.body.children)
                .filter(element => element instanceof HTMLElement && element.style.zIndex === '190').length;
            return dialogs === 0 && sheetBackdrops === 0;
        }, SETTLE_TIMEOUT_MS, monitorConsole);

        if (!clean) {
            const dialogs = document.querySelectorAll('[role="dialog"]').length;
            const sheetBackdrops = Array.from(document.body.children)
                .filter(element => element instanceof HTMLElement && element.style.zIndex === '190').length;
            throw new HarnessRunAbort(
                'HARNESS CLEANUP FAILED',
                `${scenario}: stale overlay DOM remained after ${SETTLE_TIMEOUT_MS}ms; `
                    + `dialogs=${dialogs}, sheetBackdrops=${sheetBackdrops}`,
            );
        }
    };

    const runChecks = async () => {
        setRunning(true);
        setChecks([]);
        setHarnessFailure(null);
        const next: Check[] = [];
        let failure: HarnessFailure | null = null;

        try {
            assertNoConsoleErrors();
            const mobileMediaMatches = window.matchMedia('(max-width: 767.98px)').matches;
            if (window.innerWidth >= 768 || !mobileMediaMatches) {
                throw new HarnessRunAbort(
                    'HARNESS REFUSED TO RUN — NOT MOBILE WIDTH',
                    `innerWidth=${window.innerWidth}px, mobileMediaMatches=${mobileMediaMatches}; required <768px.`,
                );
            }

            await resetOverlayState('autofocus/focus scenario');
            setTaskOpen(true);

            let taskSettlement = await settlePanelGeometry(() => findDialog('New task'), 'dialog');
            let taskPanel = taskSettlement.panel;
            const description = taskPanel?.querySelector<HTMLTextAreaElement>('textarea') ?? null;
            next.push({
                label: 'Mobile Radix mount does not autofocus Description',
                pass: taskSettlement.settled && !!description && document.activeElement !== description,
                detail: measurementDetail(
                    description,
                    'DOM focus state after bounded two-frame panel settlement; no control geometry sampled',
                    `active=${describeElement(document.activeElement)}; panelSettlement={${taskSettlement.detail}}`,
                ),
            });

            description?.focus({ preventScroll: true });
            await waitFor(() => !!description && document.activeElement === description);
            next.push({
                label: 'Tapping/focusing Description still works',
                pass: taskSettlement.settled && !!description && document.activeElement === description,
                detail: measurementDetail(
                    description,
                    'DOM focus state after bounded two-frame panel settlement; no control geometry sampled',
                    `active=${describeElement(document.activeElement)}; panelSettlement={${taskSettlement.detail}}`,
                ),
            });
            description?.blur();

            await resetOverlayState('constrained-scroller scenario');
            const constrainedHeight = Math.min(400, Math.max(300, window.innerHeight - 120));
            fakeViewport.setRect({ height: constrainedHeight, offsetTop: 0 });
            setTaskOpen(true);
            taskSettlement = await settlePanelGeometry(() => findDialog('New task'), 'dialog');
            taskPanel = taskSettlement.panel;
            const dialogBody = taskSettlement.settled
                ? taskPanel?.querySelector<HTMLElement>(':scope > .overflow-y-auto') ?? null
                : null;
            next.push({
                label: 'Production DialogBody becomes the constrained scroller',
                pass: taskSettlement.settled
                    && !!dialogBody
                    && dialogBody.scrollHeight > dialogBody.clientHeight,
                detail: taskSettlement.settled
                    ? measurementDetail(
                        dialogBody,
                        'element-local scroll metrics in CSS px after bounded two-frame panel settlement',
                        dialogBody
                            ? `scrollHeight=${dialogBody.scrollHeight} expected>clientHeight=${dialogBody.clientHeight}; `
                                + `parent maxHeight=${taskPanel?.style.maxHeight || '<unset>'}; `
                                + `panelSettlement={${taskSettlement.detail}}`
                            : `production DialogBody was not mounted; panelSettlement={${taskSettlement.detail}}`,
                    )
                    : taskSettlement.detail,
            });

            // The remaining asserted checks exercise stable production overlay contracts.
            // Keyboard/panning/focus-zoom behavior is listed below as a real-device gate.
            await resetOverlayState('overlay-stack/dismissal scenario');
            setTaskOpen(true);
            taskSettlement = await settlePanelGeometry(() => findDialog('New task'), 'dialog');
            setSheetOpen(true);
            let sheetSettlement = await settlePanelGeometry(
                () => findDialog('Viewport fixture'),
                'bottom-sheet',
            );
            let fixtureSheet = sheetSettlement.panel;
            const taskBelow = taskSettlement.panel;
            const fixtureZ = sheetSettlement.settled && fixtureSheet
                ? Number(getComputedStyle(fixtureSheet).zIndex)
                : Number.NaN;
            const taskZ = taskSettlement.settled && taskBelow
                ? Number(getComputedStyle(taskBelow).zIndex)
                : Number.NaN;
            next.push({
                label: 'BottomSheet stacks above the still-open Radix dialog',
                pass: taskSettlement.settled
                    && sheetSettlement.settled
                    && !!fixtureSheet
                    && !!taskBelow
                    && fixtureZ > taskZ,
                detail: measurementDetail(
                    fixtureSheet,
                    'computed CSS z-index after each panel reached bounded two-frame rest; no coordinate comparison',
                    `topZ=${fixtureZ}; lower=${describeElement(taskBelow)} lowerZ=${taskZ}; `
                        + `topSettlement={${sheetSettlement.detail}}; lowerSettlement={${taskSettlement.detail}}`,
                ),
            });
            const grabHandle = sheetSettlement.settled
                ? fixtureSheet?.firstElementChild as HTMLElement | null
                : null;
            next.push({
                label: 'Canonical drag handle wiring remains present',
                pass: sheetSettlement.settled && grabHandle?.style.touchAction === 'none',
                detail: measurementDetail(
                    grabHandle,
                    'inline pointer/gesture style after bounded two-frame panel settlement; no coordinate geometry',
                    `touch-action=${grabHandle?.style.touchAction || '<missing>'} expected=none; `
                        + `panelSettlement={${sheetSettlement.detail}}`,
                ),
            });

            const sheetBackdrop = sheetSettlement.settled
                ? Array.from(document.body.children)
                    .find(element => element instanceof HTMLElement && element.style.zIndex === '190') as HTMLElement | undefined
                : undefined;
            sheetBackdrop?.click();
            await waitFor(() => !findDialog('Viewport fixture'));
            next.push({
                label: 'Top-sheet backdrop closes only the top layer',
                pass: sheetSettlement.settled
                    && !findDialog('Viewport fixture')
                    && !!findDialog('New task'),
                detail: measurementDetail(
                    sheetBackdrop ?? null,
                    'DOM mounted-layer state after click on a settled panel; no coordinate geometry',
                    `topMounted=${!!findDialog('Viewport fixture')}; lowerMounted=${!!findDialog('New task')}; `
                        + `mountedDialogs=${document.querySelectorAll('[role="dialog"]').length}; `
                        + `panelSettlement={${sheetSettlement.detail}}`,
                ),
            });

            setSheetOpen(true);
            sheetSettlement = await settlePanelGeometry(
                () => findDialog('Viewport fixture'),
                'bottom-sheet',
            );
            fixtureSheet = sheetSettlement.panel;
            const sheetClose = sheetSettlement.settled
                ? fixtureSheet?.querySelector<HTMLButtonElement>('button[aria-label="Close"]') ?? null
                : null;
            sheetClose?.click();
            await waitFor(() => !findDialog('Viewport fixture'));
            next.push({
                label: 'OverlayClose closes BottomSheet without closing the dialog below',
                pass: sheetSettlement.settled
                    && !findDialog('Viewport fixture')
                    && !!findDialog('New task'),
                detail: measurementDetail(
                    sheetClose,
                    'DOM mounted-layer state after click on a settled panel; no coordinate geometry',
                    `topMounted=${!!findDialog('Viewport fixture')}; lowerMounted=${!!findDialog('New task')}; `
                        + `mountedDialogs=${document.querySelectorAll('[role="dialog"]').length}; `
                        + `panelSettlement={${sheetSettlement.detail}}`,
                ),
            });

            taskSettlement = await settlePanelGeometry(() => findDialog('New task'), 'dialog');
            taskPanel = taskSettlement.panel;
            const taskClose = taskSettlement.settled
                ? taskPanel?.querySelector<HTMLButtonElement>('button[aria-label="Close"]') ?? null
                : null;
            taskClose?.click();
            await waitFor(() => !findDialog('New task'));
            next.push({
                label: 'Radix OverlayClose still closes the task dialog',
                pass: taskSettlement.settled && !findDialog('New task'),
                detail: measurementDetail(
                    taskClose,
                    'DOM mounted-layer state after click on a settled panel; no coordinate geometry',
                    `taskMounted=${!!findDialog('New task')}; `
                        + `mountedDialogs=${document.querySelectorAll('[role="dialog"]').length}; `
                        + `panelSettlement={${taskSettlement.detail}}`,
                ),
            });
        } catch (error) {
            failure = error instanceof HarnessRunAbort
                ? { title: error.title, detail: error.message }
                : {
                    title: 'HARNESS ABORTED — RUNTIME ERROR',
                    detail: formatConsoleValue(error),
                };
        } finally {
            try {
                await resetOverlayState('post-run cleanup', false);
            } catch (cleanupError) {
                if (!failure) {
                    failure = cleanupError instanceof HarnessRunAbort
                        ? { title: cleanupError.title, detail: cleanupError.message }
                        : {
                            title: 'HARNESS CLEANUP FAILED',
                            detail: formatConsoleValue(cleanupError),
                        };
                }
            }
            if (harnessRuntime.consoleErrors.length > 0) failure = consoleFailure();
            setChecks(failure ? [] : next);
            setHarnessFailure(failure);
            setRunning(false);
        }
    };

    useEffect(() => {
        const listener = (message: string) => {
            setChecks([]);
            setHarnessFailure({
                title: 'HARNESS ABORTED — CONSOLE ERROR',
                detail: message,
            });
        };
        harnessRuntime.errorListeners.add(listener);
        if (harnessRuntime.consoleErrors.length > 0) {
            const failure = consoleFailure();
            setHarnessFailure(failure);
        }
        return () => {
            harnessRuntime.errorListeners.delete(listener);
        };
    }, []);

    useEffect(() => {
        if (!new URLSearchParams(window.location.search).has('autorun')) return;
        void runChecks();
        // Harness-only one-shot: query parameters do not change during a run.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <main className="min-h-screen bg-[var(--blanc-bg)] p-5 text-[var(--blanc-ink-1)]">
            <div className="mx-auto max-w-xl space-y-5">
                <div className="space-y-2">
                    <p className="blanc-eyebrow">SHEET-KEYBOARD-001</p>
                    <h1 className="text-2xl font-semibold">Real-component viewport harness</h1>
                    <p className="text-sm text-[var(--blanc-ink-2)]">
                        Run below 768px. The asserted suite covers deterministic production-component contracts only;
                        mobile keyboard acceptance gates are listed separately below.
                    </p>
                </div>

                {harnessFailure && (
                    <div
                        role="alert"
                        aria-live="assertive"
                        className="rounded-xl p-4"
                        style={{ background: 'var(--blanc-field)' }}
                    >
                        <p className="font-semibold text-[var(--blanc-danger)]">{harnessFailure.title}</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--blanc-ink-2)]">
                            {harnessFailure.detail}
                        </p>
                    </div>
                )}

                <div className="flex flex-wrap gap-2">
                    <Button onClick={runChecks} disabled={running}>{running ? 'Running…' : 'Run PASS/FAIL suite'}</Button>
                    <Button variant="outline" onClick={() => setTaskOpen(true)}>Open TaskFormDialog</Button>
                    <Button variant="outline" onClick={() => setSheetOpen(true)}>Open BottomSheet</Button>
                </div>

                <div className="flex flex-wrap gap-2">
                    <span className="w-full text-xs text-[var(--blanc-ink-2)]">
                        Manual synthetic viewport controls (not asserted)
                    </span>
                    <Button size="sm" variant="ghost" onClick={resetViewport}>Viewport closed</Button>
                    <Button size="sm" variant="ghost" onClick={() => fakeViewport.setRect({ height: 400, offsetTop: 0 })}>Keyboard first-open</Button>
                    <Button size="sm" variant="ghost" onClick={() => fakeViewport.setRect({ height: 360, offsetTop: Math.max(0, window.innerHeight - 360) })}>Keyboard panned</Button>
                    <Button size="sm" variant="ghost" onClick={() => fakeViewport.setRect({ height: 230, offsetTop: 40, scale: 1.2 })}>Focus zoom</Button>
                </div>

                {checks.length > 0 && (
                    <div className="space-y-2" aria-live="polite">
                        <p className="blanc-eyebrow">
                            {checks.filter(check => check.pass).length}/{checks.length} passing
                        </p>
                        {checks.map(check => (
                            <div
                                key={check.label}
                                className="rounded-xl px-3 py-2 text-sm"
                                style={{ background: 'var(--blanc-field)' }}
                            >
                                <p
                                    className="font-semibold"
                                    style={{ color: check.pass ? 'var(--blanc-success)' : 'var(--blanc-danger)' }}
                                >
                                    {check.pass ? 'PASS' : 'FAIL'} · {check.label}
                                </p>
                                <p className="text-xs text-[var(--blanc-ink-2)]">{check.detail}</p>
                            </div>
                        ))}
                    </div>
                )}

                <section className="space-y-2">
                    <p className="blanc-eyebrow">REAL-DEVICE ONLY (not asserted here)</p>
                    <p className="text-sm text-[var(--blanc-ink-2)]">
                        Verify these with an actual mobile OS keyboard; the desktop VisualViewport fake is not an acceptance test.
                    </p>
                    <ul className="space-y-2">
                        {REAL_DEVICE_ONLY_CHECKS.map(check => (
                            <li
                                key={check.label}
                                className="rounded-xl px-3 py-2 text-sm"
                                style={{ background: 'var(--blanc-field)' }}
                            >
                                <p className="font-semibold">{check.label}</p>
                                <p className="text-xs text-[var(--blanc-ink-2)]">{check.reason}</p>
                            </li>
                        ))}
                    </ul>
                </section>
            </div>

            <TaskFormDialog
                open={taskOpen}
                onOpenChange={setTaskOpen}
                parentType="job"
                parentId={1}
                tz="America/New_York"
                onSaved={() => setTaskOpen(false)}
            />

            <BottomSheet
                open={sheetOpen}
                onClose={() => setSheetOpen(false)}
                title="Viewport fixture"
                size="full"
            >
                <div className="space-y-3">
                    <p>This is the production fixed-height BottomSheet.</p>
                    <input
                        aria-label="Fixture field"
                        className="h-[50px] w-full rounded-xl bg-[var(--blanc-field)] px-3"
                    />
                </div>
            </BottomSheet>
        </main>
    );
}

const rootContainer = document.getElementById('root');
if (!rootContainer) throw new Error('Sheet keyboard harness root container is missing.');
const root = harnessRuntime.root ?? createRoot(rootContainer);
harnessRuntime.root = root;
root.render(
    <OverlayStackProvider>
        <Harness />
    </OverlayStackProvider>,
);
