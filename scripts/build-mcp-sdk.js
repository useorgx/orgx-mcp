#!/usr/bin/env node
/**
 * Build script for MCP Apps SDK UMD bundle
 *
 * Bundles @modelcontextprotocol/ext-apps App class as a UMD module
 * that widgets can load via <script> tag.
 *
 * Output: public/widgets/shared/mcp-apps-sdk.umd.js
 *
 * Usage: node scripts/build-mcp-sdk.js
 */

import { build } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { copyFileSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

async function buildSdk() {
  console.log('Building MCP Apps SDK UMD bundle...');

  const distDir = resolve(rootDir, 'dist');
  const outputFile = 'mcp-apps-sdk.umd.js';
  const targetDir = resolve(rootDir, 'public/widgets/shared');
  const targetFile = resolve(targetDir, outputFile);

  try {
    await build({
      configFile: false,
      root: rootDir,
      publicDir: false, // Disable public directory copying
      build: {
        lib: {
          entry: resolve(rootDir, 'src/mcp-sdk-entry.js'),
          name: 'McpApps',
          formats: ['umd'],
          fileName: () => outputFile,
        },
        outDir: distDir,
        emptyOutDir: true,
        minify: true,
        sourcemap: false,
        rollupOptions: {
          output: {
            // Expose as window.McpApps
            name: 'McpApps',
            // Ensure clean global export
            exports: 'named',
          },
        },
      },
      logLevel: 'info',
    });

    // Copy the built file to the widgets shared directory
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(resolve(distDir, outputFile), targetFile);

    console.log('MCP Apps SDK bundle built successfully!');
    console.log(`Output: ${targetFile}`);
  } catch (error) {
    console.error('Failed to build MCP Apps SDK bundle:', error);
    process.exit(1);
  }
}

buildSdk();
