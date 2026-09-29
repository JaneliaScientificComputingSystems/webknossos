/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />


// This file is used to add types to the import.meta.env object
// vitest set's MODE to test during (unit) tests
interface ImportMetaEnv {
  readonly MODE: "production" | "development" | "test"
  readonly BASE_URL: string
  readonly PROD: boolean
  readonly DEV: boolean
  readonly SSR: boolean
  // Base URL of tools/neuron_identity_service; defaults to http://localhost:8010 if unset.
  readonly VITE_PREDICTION_SERVICE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
