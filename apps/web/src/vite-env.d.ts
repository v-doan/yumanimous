/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API origin in production (e.g. https://api.example.com). Empty in dev: Vite proxies. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
