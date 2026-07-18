import { describe, expect, it } from 'vitest';
import { computeSheetViewportGeometry, isSheetControlCovered } from './useSheetViewport';

describe('computeSheetViewportGeometry', () => {
    it('lifts a first-open mobile sheet above an overlaid keyboard', () => {
        expect(computeSheetViewportGeometry({
            layoutHeight: 844,
            visualHeight: 500,
            visualOffsetTop: 0,
        })).toEqual({
            visualTop: 0,
            visualBottom: 500,
            visibleHeight: 500,
            bottomInset: 344,
            usableHeight: 484,
        });
    });

    it('keeps a browser-panned sheet at layout bottom while respecting visible height', () => {
        expect(computeSheetViewportGeometry({
            layoutHeight: 844,
            visualHeight: 500,
            visualOffsetTop: 344,
        })).toEqual({
            visualTop: 344,
            visualBottom: 844,
            visibleHeight: 500,
            bottomInset: 0,
            usableHeight: 484,
        });
    });

    it('preserves the no-keyboard geometry and canonical top gap', () => {
        expect(computeSheetViewportGeometry({
            layoutHeight: 844,
            visualHeight: 844,
            visualOffsetTop: 0,
        })).toEqual({
            visualTop: 0,
            visualBottom: 844,
            visibleHeight: 844,
            bottomInset: 0,
            usableHeight: 828,
        });
    });

    it('tolerates focus-zoom values without assuming scale-one geometry', () => {
        expect(computeSheetViewportGeometry({
            layoutHeight: 844,
            visualHeight: 312.5,
            visualOffsetTop: 81.25,
            topGap: 16,
        })).toEqual({
            visualTop: 81.25,
            visualBottom: 393.75,
            visibleHeight: 312.5,
            bottomInset: 450.25,
            usableHeight: 296.5,
        });
    });

    it.each([
        ['390x844 first-open', 844, 400, 0, 444, 384],
        ['375x812 first-open', 812, 400, 0, 412, 384],
        ['390x844 focus-zoom', 844, 230, 40, 574, 214],
        ['375x812 focus-zoom', 812, 230, 40, 542, 214],
        ['390x844 restored', 844, 844, 0, 0, 828],
        ['375x812 restored', 812, 812, 0, 0, 796],
    ])('maps the %s harness state exactly', (
        _name,
        layoutHeight,
        visualHeight,
        visualOffsetTop,
        bottomInset,
        usableHeight,
    ) => {
        expect(computeSheetViewportGeometry({
            layoutHeight,
            visualHeight,
            visualOffsetTop,
        })).toMatchObject({ bottomInset, usableHeight });
    });

    it('clamps stale, negative, and out-of-layout measurements safely', () => {
        expect(computeSheetViewportGeometry({
            layoutHeight: 844,
            visualHeight: 200,
            visualOffsetTop: 800,
        })).toEqual({
            visualTop: 800,
            visualBottom: 844,
            visibleHeight: 44,
            bottomInset: 0,
            usableHeight: 28,
        });
        expect(computeSheetViewportGeometry({
            layoutHeight: 844,
            visualHeight: -10,
            visualOffsetTop: -20,
        })).toEqual({
            visualTop: 0,
            visualBottom: 0,
            visibleHeight: 0,
            bottomInset: 844,
            usableHeight: 0,
        });
        expect(computeSheetViewportGeometry({
            layoutHeight: Number.NaN,
            visualHeight: Number.POSITIVE_INFINITY,
            visualOffsetTop: Number.NaN,
        })).toEqual({
            visualTop: 0,
            visualBottom: 0,
            visibleHeight: 0,
            bottomInset: 0,
            usableHeight: 0,
        });
    });

    it('allows a caller gap to consume all remaining visible height', () => {
        expect(computeSheetViewportGeometry({
            layoutHeight: 600,
            visualHeight: 40,
            visualOffsetTop: 100,
            topGap: 64,
        })?.usableHeight).toBe(0);
    });

    it('returns no override when VisualViewport metrics are unavailable', () => {
        expect(computeSheetViewportGeometry(null)).toBeNull();
    });
});

describe('isSheetControlCovered', () => {
    const geometry = {
        visualTop: 40,
        visualBottom: 270,
        visibleHeight: 230,
        bottomInset: 574,
        usableHeight: 214,
    };

    it('keeps a control inside the reveal margin in place', () => {
        expect(isSheetControlCovered({ top: 48, bottom: 262 }, geometry)).toBe(false);
    });

    it('detects controls covered above or below the visual viewport', () => {
        expect(isSheetControlCovered({ top: 47, bottom: 100 }, geometry)).toBe(true);
        expect(isSheetControlCovered({ top: 200, bottom: 263 }, geometry)).toBe(true);
    });
});
