import { authedFetch } from '../services/apiClient';

/**
 * Open an auth-guarded PDF in a new tab, degrading to a file DOWNLOAD when the
 * popup is unavailable.
 *
 * OB-29: prod logs showed the PDF requests reaching the backend with no error,
 * yet "nothing happened" for the user — the synchronous `window.open('')` can
 * return null (popup blockers, iOS/standalone PWA) and the old post-await
 * `window.open(objectUrl)` fallback is ALWAYS blocked (no user gesture by
 * then). A programmatic anchor download needs no popup permission, so the
 * button always produces a visible result.
 */
export async function openAuthedPdf(url: string, filename = 'document.pdf'): Promise<void> {
    const popup = window.open('', '_blank');

    try {
        const response = await authedFetch(url);
        if (!response.ok) throw new Error(`Could not fetch PDF: ${response.status}`);

        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);

        if (popup) {
            popup.location.href = objectUrl;
        } else {
            const anchor = document.createElement('a');
            anchor.href = objectUrl;
            anchor.download = filename;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
        }

        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (error) {
        popup?.close();
        throw error;
    }
}
