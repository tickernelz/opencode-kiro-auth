// Repo-root entrypoint kept in sync with the published API in src/index.ts.
// The npm package ships dist/index.js (built from src/index.ts); this file is a
// convenience re-export for source consumers and must not diverge.
export * from './src/index'
export { default } from './src/index'
