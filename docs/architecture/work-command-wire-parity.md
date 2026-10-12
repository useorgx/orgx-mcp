# Work-command wire ownership

OrgX's existing v1 command routes own stable creation identity, workspace inbox
resolution, hierarchy authorization and signed concurrency-token validation.
MCP adapts tool arguments to those routes. With an explicit retry key and no
command ID it sends the same body on each attempt; the server derives the ID.
The response keeps `command_id`, using the returned canonical `taskId` when the
caller omitted an ID. The SQL command persists both identities as the same ID.

Completion accepts the existing server-issued token or the original timestamp
and aggregate-version pair. Supplied raw fields remain validated. Measured
hours preserve omitted, null and zero values. These inputs remain producer
claims; successful recording does not establish verification or acceptance.

Each operation uses one canonical request. Cached clients supplying the original
full hierarchy and raw concurrency pair keep their previous wire shape. New
arguments use existing server capabilities, with no new endpoint, extra lookup
or client-side authority calculation. Discovery and negative handler tests cover
both forms, including refusal when neither concurrency form is present.
