// Types the value globalSetup.ts provides and testDatabase.ts injects. No runtime code.
export {};

declare module 'vitest' {
  export interface ProvidedContext {
    /** Admin connection string for a test Postgres, or '' when none is available. */
    databaseUrl: string;
  }
}
