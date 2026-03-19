/**
 * MCP Apps SDK Entry Point for UMD Bundle
 *
 * This file exports the App class and related utilities from @modelcontextprotocol/ext-apps
 * for use in browser widgets. The bundle is built as a UMD module and exposed as window.McpApps.
 */

// Use the pre-bundled version that includes dependencies
export {
  App,
  PostMessageTransport,
  RESOURCE_URI_META_KEY,
  RESOURCE_MIME_TYPE,
  applyHostStyleVariables,
  applyHostFonts,
  getDocumentTheme,
  applyDocumentTheme,
} from '@modelcontextprotocol/ext-apps/app-with-deps';
