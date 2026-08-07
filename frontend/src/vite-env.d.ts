/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_API_URL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

// PWA-UPDATE-001 — build stamp injected by vite.config `define`.
declare const __APP_VERSION__: string;
