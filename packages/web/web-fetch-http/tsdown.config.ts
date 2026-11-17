import { defineConfig } from 'tsdown'

/** Build the provider and its path-loaded PDF extraction Worker as separate bundles. */
export default defineConfig(({ env }) => env?.DSH_BUILD_FACE === 'client' ? [] : [
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    // The parent loads this file by URL, so its name is part of the contract;
    // `pdfjs-dist` stays external and resolves from this package's dependencies.
    entry: { 'pdf-worker': 'lib/types/worker.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
