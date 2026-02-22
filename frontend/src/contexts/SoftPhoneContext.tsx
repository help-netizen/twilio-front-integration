/**
 * SoftPhoneContext — allows any component to open the SoftPhone dialer
 * with a pre-filled phone number and optional contact name.
 */

import React, { createContext, useContext, useCallback, useState } from 'react';

interface SoftPhoneRequest {
    phone: string;
    contactName?: string;
}

interface SoftPhoneContextType {
    /** Open the SoftPhone with a pre-filled number */
    openDialer: (phone: string, contactName?: string) => void;
    /** Pending request from click-to-call — consumed by SoftPhone widget */
    pendingRequest: SoftPhoneRequest | null;
    /** Clear the pending request after SoftPhone has consumed it */
    clearPending: () => void;
}

const SoftPhoneContext = createContext<SoftPhoneContextType>({
    openDialer: () => { },
    pendingRequest: null,
    clearPending: () => { },
});

export const useSoftPhone = () => useContext(SoftPhoneContext);

export const SoftPhoneProvider: React.FC<{
    children: React.ReactNode;
    onOpenRequested: () => void;
}> = ({ children, onOpenRequested }) => {
    const [pendingRequest, setPendingRequest] = useState<SoftPhoneRequest | null>(null);

    const openDialer = useCallback((phone: string, contactName?: string) => {
        setPendingRequest({ phone, contactName });
        onOpenRequested();
    }, [onOpenRequested]);

    const clearPending = useCallback(() => {
        setPendingRequest(null);
    }, []);

    return (
        <SoftPhoneContext.Provider value={{ openDialer, pendingRequest, clearPending }}>
            {children}
        </SoftPhoneContext.Provider>
    );
};
