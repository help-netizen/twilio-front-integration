import { test as base, expect } from '@playwright/test';

/**
 * Shared `test` with CSS animations/transitions forced to 0s on every page.
 *
 * The app doesn't honor prefers-reduced-motion for its slide-overs / Radix
 * menus, so `reducedMotion: 'reduce'` alone didn't help — Playwright kept hitting
 * "element is not stable" while a dialog/select was still animating. This init
 * script injects an !important override that kills the motion deterministically,
 * so elements settle immediately and clicks are reliable.
 *
 * All specs import { test, expect } from here instead of '@playwright/test'.
 */
export const test = base.extend({
    page: async ({ page }, use) => {
        await page.addInitScript(() => {
            // The softphone warm-up summary is unrelated to the flow under test and
            // uses a sessionStorage latch. Without priming it, its Radix scrim can
            // appear after navigation and cover an already-open create panel.
            sessionStorage.setItem('albusto_warmup_shown', '1');
            const css =
                '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;' +
                'transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important}';
            const inject = () => {
                if (document.querySelector('style[data-e2e-no-anim]')) return;
                const style = document.createElement('style');
                style.setAttribute('data-e2e-no-anim', '');
                style.textContent = css;
                (document.head || document.documentElement).appendChild(style);
            };
            inject();
            document.addEventListener('DOMContentLoaded', inject);
        });
        await use(page);
    },
});

export { expect };
