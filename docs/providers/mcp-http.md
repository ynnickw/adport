# Hosted MCP HTTP lifecycle

Adport Cloud serves authenticated, stateless MCP POST exchanges. The same shared
tool registry and policy engine serve both supported protocol eras. This does
not add an HTTP mode to the local stdio server or CLI.

Authenticated GET and DELETE requests return `405 Method Not Allowed` with
`Allow: POST`. There is no persistent session or standalone notification stream
at this endpoint. Unauthenticated requests still receive the normal bearer
challenge; unsupported methods do not assemble a tenant/provider runtime.

Each POST has a fresh server with a snapshot of the caller's permitted tools and
static UI resources. Cloud therefore advertises `listChanged: false` and
`resources.subscribe: false`. The per-request servers have no shared change
publisher. Advertising live catalogue updates would cause clients to open idle
subscription POSTs that cannot receive those updates. Refresh the host's tool
list or reconnect after changing tool access, as the connection instructions
already describe. Galleries and asset workflows continue to refresh through
their normal tool calls.

The installed SDK handles modern `2026-07-28` requests, including metadata and
header validation, version errors, request-scoped progress notifications and the
terminal response. Modern tool progress can still use SSE. An explicit change
subscription receives an empty acknowledgement and a finite complete response
because this server publishes none of the requested change events.

Legacy `2025` requests retain JSON responses and the SDK's stateless validation.
Their server is closed after the response is ready, including notification and
error responses. A cleanup failure cannot replace an already-completed tool
result with a transport/authentication error or authorize a replay. It emits
only a static operational diagnostic; private error details are not logged.

## Verification

Regression coverage uses the actual cloud route and installed MCP SDK, with
isolated authentication/runtime fixtures and external requests denied. It checks
GET/DELETE completion, authentication, both protocol eras, catalogue discovery,
read-only enforcement, resource delivery, subscription completion, progress SSE,
legacy cleanup and version errors. These tests are not actual Claude/ChatGPT
browser verification or native provider-write certification.

The earlier production logs contain both GET and POST `/mcp` requests that reached
the 300-second function limit. The SDK probes reproduce unsupported idle GETs
and automatic subscription POSTs caused by the old capability declarations.
Those paths do not establish the cause of every historical POST timeout. Live
checks must report a bounded observation window and must not infer overall
reliability from an HTTP 200 response or a short empty error-log query.

References: official [Streamable HTTP specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
and [TypeScript SDK HTTP serving guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md).
