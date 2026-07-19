import { describe, it, expect } from 'vitest';
import source from './RecommendationSettings.tsx?raw';

/**
 * MinutePicker regression — the segmented 0/30/60/Custom control.
 *
 * Bug: `useState(!isPreset)` seeded "Custom" from the value at MOUNT. Settings
 * load asynchronously, so the first render sees local defaults; by the time the
 * saved value (e.g. 30) arrived, the control was already latched to Custom and
 * never recovered. Symptom: pick 30 → Save → reload → shows Custom with 30 in
 * the free-text input.
 *
 * Fix: Custom is an explicit user choice only (`useState(false)`); a saved
 * non-preset value still opens the input through `!isPreset`.
 */
describe('MinutePicker preset/custom latching', () => {
    it('does not seed the Custom toggle from the mount-time value', () => {
        expect(source).toContain('const [custom, setCustom] = useState(false);');
        expect(source).not.toContain('useState(!isPreset)');
    });

    it('still derives the custom input from a non-preset value', () => {
        expect(source).toContain('const showCustomInput = custom || !isPreset;');
    });

    it('selecting a preset clears the custom toggle', () => {
        expect(source).toContain('onClick={() => { setCustom(false); onChange(String(p)); }}');
    });
});
