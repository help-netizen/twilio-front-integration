import { describe, expect, it } from 'vitest';
import { shouldPromptReload } from './useAppUpdate';

describe('shouldPromptReload (PWA-UPDATE-001)', () => {
    it('prompts when the deployed version differs from the running one', () => {
        expect(shouldPromptReload('build-1', 'build-2')).toBe(true);
    });

    it('does not prompt for the same version', () => {
        expect(shouldPromptReload('build-1', 'build-1')).toBe(false);
    });

    it('never prompts when version.json is missing or empty (so a fetch blip is not a false reload)', () => {
        expect(shouldPromptReload('build-1', null)).toBe(false);
        expect(shouldPromptReload('build-1', undefined)).toBe(false);
        expect(shouldPromptReload('build-1', '')).toBe(false);
    });
});
