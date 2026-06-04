/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BFF_WSS_URL: string;
  readonly VITE_BFF_HTTP_URL: string;
  readonly VITE_WC_PROJECT_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
