import { authedFetch } from '../services/apiClient';

export async function openAuthedPdf(url: string): Promise<void> {
    const popup = window.open('', '_blank');

    try {
        const response = await authedFetch(url);
        if (!response.ok) throw new Error(`Could not fetch PDF: ${response.status}`);

        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);

        if (popup) {
            popup.location.href = objectUrl;
        } else {
            window.open(objectUrl, '_blank');
        }

        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (error) {
        popup?.close();
        throw error;
    }
}
