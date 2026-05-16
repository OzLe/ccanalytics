/// <reference types="vite/client" />

/**
 * App version injected at build time by `vite.config.ts` from
 * `../src/version.ts` (or `../package.json` as a fallback).
 *
 * - `__APP_VERSION__`       — short semver (e.g. `0.1.5`)
 * - `__APP_FULL_VERSION__`  — semver + commit count + short hash
 *                              (e.g. `0.1.5+34.5bdc6fa`)
 */
declare const __APP_VERSION__: string;
declare const __APP_FULL_VERSION__: string;
