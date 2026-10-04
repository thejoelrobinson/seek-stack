# @deepseek-ai/dsh-web-search-chrome-mcp

Local (unpublished) `web_search` provider for the DeepSeek Harness **ctx.web seam**:
search runs through a **real Chrome browser** (raw CDP), not an API.

```
model: web_search  ->  ctx.web  ->  this provider (id: chrome-mcp)
                                    -> MCP client (stdio)
                                       -> ~/.dsh/chrome-mcp/server.js (MCP server)
                                          -> Chrome (headless, throwaway profile, raw CDP)
```

## Status: OFF by default

The `web` row in `~/.dsh/cordis.patch.yml` selects `deepseek-official` (the local
SearXNG adapter) unless one of:

1. `DSH_WEB_SEARCH_PROVIDER=chrome-mcp` is set when `dsh web` starts, or
2. the `web` row's `searchProvider` is edited to `chrome-mcp`.

Registering this provider is safe while off: an explicitly configured provider
id always wins, and `available()` returns false (failing loud with
`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`) if Chrome or the server script is missing.

## Why local, not npm

The registry providers pin `dsh-web@^0.0.1-rc.x` and would create a **second seam
instance**. This package lives in the shared `~/.dsh/profiles/node_modules` and
resolves against the same host `dsh-web` copy the running harness uses.

## Files

- `lib/index.js` - the plugin (provider id `chrome-mcp`, settings namespace
  `web-search-chrome-mcp`).
- `~/.dsh/chrome-mcp/server.js` - the stdio MCP server (MCP SDK + zod, Chrome
  via raw CDP on the Node >= 22 global WebSocket).
- `~/.dsh/chrome-mcp/package.json` - server package marker (`type: module`).

## Settings (namespace web-search-chrome-mcp)

| key | default | notes |
| --- | --- | --- |
| `chromePath` | platform default | path to chrome.exe |
| `serverScript` | `~/.dsh/chrome-mcp/server.js` | the MCP server |
| `engine` | `ddg` | `ddg` (HTML endpoint), `bing`, `google` |
| `maxResults` | 8 | cap when the caller doesn't specify one |
| `headless` | true | false = visible window (debugging) |
| `searchTimeoutMs` | 60000 | per-search timeout |

## Server env (forwarded by the provider)

`CHROME_PATH`, `CHROME_MCP_HEADLESS` ("0" = visible). Server also honors
`CHROME_MCP_USER_DATA_DIR` (default: fresh mkdtemp under the OS temp dir) and
`CHROME_MCP_IDLE_EXIT_MS` (default 30 min; Chrome relaunches on the next
search after idle exit - the MCP server process itself stays up).

## Tools exposed by the MCP server

- `search {query, engine?, maxResults?}` - scrape organic results.
- `page {url}` - load a URL and return title + visible text.

## Tests performed

See the build report: T1 (standalone MCP driver against live Chrome),
T4 (provider isolation with a fake ctx), T2/T3 (e2e through a scratch headless
profile, default path unchanged + env flip).
