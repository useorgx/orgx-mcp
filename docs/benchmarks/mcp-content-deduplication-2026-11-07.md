# MCP content deduplication for CLI clients

The audit found large response bodies on progress, search and status paths. Widget-capable legacy clients retain their JSON-first content block. Codex and OpenCode now use the same summary-only text representation already used for Claude Code, with the complete result still in `structuredContent`. Proof IDs, bodies, version markers and widget data remain available without a second JSON copy in model-visible text. Unknown clients, ChatGPT and Cursor retain their existing wire contract.

The regression serializes an actual MCP result containing a 100,000-character proof body before and after the change. It requires identical structured proof and at least a 49% reduction in serialized result size. This is a controlled wire-size comparison, not a production latency percentile. Actual savings depend on the ratio of structured data to summary size, and eligible client traffic must be measured separately from unchanged clients.

Validation: agent ergonomics, widget artifact proof and scaffold registration suites; TypeScript. The common helper serves status, progress and other widget-backed operation results.
