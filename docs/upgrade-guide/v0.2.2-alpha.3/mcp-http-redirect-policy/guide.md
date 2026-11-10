---
kind: upgrade-guide
description: Streamable HTTP MCP connections reject redirects to another origin.
---

# Configure the final MCP endpoint URL

English | [中文](guide.zh.md)

## Change

Streamable HTTP MCP connections no longer follow redirects to a different scheme, hostname, or port. Previously these redirects could forward custom authentication headers, the MCP session ID, and request bodies to another origin. Connections through such redirects now fail, including changes from HTTP to HTTPS on the same hostname. POST requests continue to follow same-origin 307 and 308 redirects, but reject 301, 302, and 303 redirects that would change the request method. Stdio connections are unchanged.

## Migration

1. Find each `mcp-client` entry using `transport: streamable-http` in your `cordis.yml` or profile patch.
2. If its `url` redirects to another origin or uses 301, 302, or 303 for POST requests, replace `url` with the intended MCP server's final endpoint. Confirm that this server is trusted to receive the configured headers and requests.
3. Reload the entry and call one of the server's tools. A successful call confirms that the endpoint accepts the connection without a cross-origin redirect.
