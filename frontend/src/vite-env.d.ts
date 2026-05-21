/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BFF_URL: string;
  readonly VITE_ZERODEV_PROJECT_ID: string;
  readonly VITE_BUNDLER_URL: string;
  readonly VITE_PAYMASTER_URL: string;
  readonly VITE_SENTINEL_ADDRESS: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
