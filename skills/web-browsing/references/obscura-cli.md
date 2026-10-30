# Obscura CLI reference (verified on obscura 0.2.5)

Global flags go before the subcommand: `-v/--verbose`, `-p/--port`, `--proxy URL`, `--stealth`,
`--obey-robots`, `--user-agent STR`, `--storage-dir DIR`, `--allow-private-network`,
`--v8-flags "…"`; `-h/--help`, `-V/--version`. `--stealth`, `--obey-robots`, `--proxy` and
`--allow-private-network` apply to `fetch`, `serve`, `scrape`, and `mcp` however they are placed.

## `obscura fetch URL`

Renders one page in a fresh browser and writes the dump to stdout (or `-o FILE`).

| Flag                                                            | Meaning                                                                                                                                                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--dump html\|text\|links\|markdown\|original\|assets\|cookies` | `html` default. `links` = tab-separated URL, text. `original` = raw response body, binary-safe, **no JS/DOM layer** (JSON, images, CSS). `assets` = NDJSON of every sub-resource URL. `cookies` = the whole jar as JSON, HttpOnly included |
| `-e, --eval JS`                                                 | Evaluate an expression; prints the JSON-encoded result. With `--eval` and no `--dump`, only the eval result is printed                                                                                                                     |
| `--selector CSS`                                                | Wait for this element before dumping                                                                                                                                                                                                       |
| `--wait S`                                                      | Post-load settle. Unset = adaptive, capped at 5s; an explicit value is a **fixed** delay, so pass it only when needed                                                                                                                      |
| `--timeout S`                                                   | Navigation budget, default 30                                                                                                                                                                                                              |
| `--wait-until load\|domcontentloaded\|networkidle0`             | Which load event to wait for                                                                                                                                                                                                               |
| `-s, --screenshot FILE`                                         | PNG of the settled page (render build)                                                                                                                                                                                                     |
| `-o, --output FILE`                                             | Write dump/eval output to a file                                                                                                                                                                                                           |
| `-q, --quiet`                                                   | No banner/progress on stderr                                                                                                                                                                                                               |
| `--file FILE`                                                   | Batch: newline-separated URLs (`-` = stdin); each URL is fetched with `--dump original` and one JSON status line is printed per URL. `--concurrency N`                                                                                     |

Exit status: 1 on navigation/network failure (message on stderr), 0 for HTTP errors such as 404.
Private/loopback targets are refused by the SSRF guard unless `--allow-private-network` or
`OBSCURA_ALLOW_PRIVATE_NETWORK=1`.

## `obscura scrape URL...`

Parallel rendering with worker processes (`obscura-worker` must sit next to the `obscura` binary).
`--eval JS` per page, `--format json|text`, `--concurrency N` (default 10), `--timeout S` (default 60),
`-q` to silence progress. Results keep input order. Use it for tens/hundreds of URLs; `fetch` in a
shell loop is fine for a handful.

## `obscura serve`

CDP WebSocket server (what `scripts/browse.mjs` drives).

`--port` (9222), `--host` (127.0.0.1), `--workers N`, `--max-connections` (128 per worker),
`--worker-max-connections/-rss/-age`, `--worker-drain-timeout`, `--ready-file PATH`,
`--allow-file-access` (lets CDP clients open `file://`), `--font-dir DIR`, `--quiet`.

Discovery: `GET /json/version` → `webSocketDebuggerUrl`, `GET /json/list` → page targets. Connect to
the **browser** endpoint, then `Target.createTarget` + `Target.attachToTarget {flatten:true}` and send
every later command with that `sessionId` (connecting straight to a `/devtools/page/…` endpoint fails
with "No page for session").

Verified behaviour, worth knowing before designing around it:

- The page target is torn down when the CDP connection closes: the DOM and the cookie jar are per-page,
  so all steps of a flow must happen on one connection.
- `Network.setCookies` / `Storage.setCookies` accept the call but do nothing, and `--storage-dir` was
  observed to write nothing, so there is no cookie re-injection or profile reuse between runs.
- Working domains for a browsing agent: `Target`, `Page` (incl. `captureScreenshot`, `printToPDF`,
  `startScreencast`), `Runtime`, `DOM`, `DOMSnapshot`, `Accessibility.getFullAXTree`, `Network`
  (incl. live `Fetch` interception and `IO.read` streaming), `Input.dispatchMouseEvent`/`dispatchKeyEvent`
  (events arrive trusted), and the non-standard `LP.getMarkdown` for DOM → Markdown.
- `Input.dispatchMouseEvent` needs coordinates: get them from `DOM.getBoxModel` on a
  `Runtime.evaluate` object id. `element.click()` via `Runtime.evaluate` is a fine fallback.
- `serve` never exits on idle, so it is stopped by killing a recorded pid (`scripts/browse.mjs stop`
  does this). Cleaning up by pattern needs `pkill -f "obscura[ ]serve"` — the plain pattern also matches
  the shell running it.

## `obscura mcp`

Model Context Protocol server: stdio by default, `--http --port 3000` for `http://127.0.0.1:3000/mcp`.
Tools: `browser_navigate`, `browser_snapshot`, `browser_screenshot`, `browser_pdf`, `browser_click`,
`browser_fill`, `browser_type`, `browser_press_key`, `browser_select_option`, `browser_evaluate`,
`browser_wait_for`, `browser_network_requests`, `browser_console_messages`, `browser_close`.
If browsing becomes a constant need rather than an occasional one, wire this into
`~/.pi/agent/mcp.json` instead of driving the CLI; `OBSCURA_MCP_TOKEN` / `OBSCURA_MCP_ALLOWED_ORIGINS`
guard the HTTP transport.

## Environment variables that matter

`OBSCURA_ALLOW_PRIVATE_NETWORK=1`, `OBSCURA_STEALTH`, `OBSCURA_OBEY_ROBOTS`, `OBSCURA_PROXY`,
`OBSCURA_FETCH_TIMEOUT_MS`, `OBSCURA_NAV_TIMEOUT_MS`, `OBSCURA_CDP_COMMAND_TIMEOUT_MS`,
`OBSCURA_SCRIPT_DEADLINE_MS` (script budget, default 30s — raise for heavy SPAs),
`OBSCURA_MODULE_BUDGET_MS` (per-module budget, default 3s),
`OBSCURA_NETWORK_BODY_BUFFER_BYTES` (response bodies kept, default 2 MiB),
`OBSCURA_FETCH_MAX_BODY_BYTES`, `OBSCURA_STORAGE_DIR`, `OBSCURA_GEOLOCATION`, `OBSCURA_TIMEZONE`.

## Build variants

Release archives come as plain (render, no stealth transport), `-stealth`, `-no-render`, and
`-no-render-stealth`. The local binary is a render build without the stealth build feature, so
`--stealth` gives fingerprint consistency and tracker blocking but not TLS impersonation.
