---

name: web-browsing
description: Read, search, and scrape the live web with Obscura, a headless browser that runs JavaScript. Use for fetching URLs, web search, extracting page content, hitting JSON APIs, screenshots, and multi-step flows (login, pagination, click-throughs) that curl cannot do.
compatibility: Obscura binary on PATH or at ~/Apps/obscura/obscura
---

# Web browsing with Obscura

`obscura` is a headless browser (real JavaScript, no Chromium) at `~/Apps/obscura/obscura`, also on
PATH. Prefer the helpers in this skill's `scripts/` directory — Pi shows the skill's path above, and the
helpers pick sane defaults while keeping page dumps out of the conversation by writing them to files.

```bash
scripts/web.sh search "query" [-n N]        # numbered web-search results (title, url, snippet)
scripts/web.sh read URL [mode] [flags]      # page -> file + short preview
scripts/web.sh eval URL 'JS expression'     # one-off DOM/data extraction
scripts/web.sh shot URL [path]              # PNG of the settled page
scripts/web.sh doctor                       # which binary, which cache dir
```

Modes for `read`: default `markdown` (best for articles), `--text`, `--links`, `--html`, and `--raw`
for JSON/API/binary bodies (`--raw` skips the browser entirely). Flags: `--selector CSS` (wait for an
element on a JS-rendered page), `--wait S`, `--timeout S`, `--stealth`, `--robots`, `-o PATH`, `--print`.

Dumps land in `$TMPDIR/web-browsing/` (one stable file per URL) and stdout carries a preview: ~2500
chars for rendered pages, ~8000 for `--raw` bodies, which are usually small enough to read inline.
`--print` sends the whole file. **Read a saved page with the read tool or grep it — never `cat` it.**

## How to work

1. `search`, then `read` the promising result. Skip searching when the URL is already known.
2. For structured data on a known page, `eval` a JS expression instead of dumping the page:
   `scripts/web.sh eval URL "JSON.stringify([...document.querySelectorAll('a')].map(a => a.href))"`.
3. For a JSON endpoint or a file, use `--raw`.
4. If a page comes back empty or shell-like, it needs JS: add `--selector` for the element you want.
   A site that stays empty may be blocking headless browsers — retry with `--stealth`, and if that
   fails, say so rather than inventing content.
5. Screenshots are for things markdown cannot show (layout, charts, a captcha to describe). Open the
   PNG with the read tool.

## Multi-step pages

`scripts/browse.mjs` drives one page over CDP — click, fill, press, paginate, screenshot in one chain:

```bash
scripts/browse.mjs 'goto https://quotes.toscrape.com/login' \
  'fill #username admin' 'fill #password admin' 'click input[type=submit]' \
  'wait .quote' 'markdown'
```

Commands: `goto URL`, `wait SELECTOR`, `click SELECTOR`, `fill SELECTOR TEXT`, `press KEY`,
`eval JS`, `markdown`, `text`, `html`, `links`, `scroll [PIXELS]`, `shot [PATH]`, `cookies`.
Chain every step of a flow in one call: Obscura drops the page (DOM, cookies) when the connection
closes, so a call is the session. `--stdout` prints dumps instead of saving them. The CDP server starts
detached and is reused by later calls — `scripts/browse.mjs status` and `doctor` report it, and
`scripts/browse.mjs stop` shuts it down when you are done.

## Limits

- Obscura blocks private/loopback addresses: add `--allow-private-network` for local dev servers.
- `--storage-dir` does not carry cookies between runs, and `Network.setCookies` is a no-op: script the
  whole login inside one `browse.mjs` call.
- A navigation error exits 1 with a message on stderr; an HTTP 404 does not fail — check the content.
- Slow pages: raise `--timeout` (default 30) rather than retrying blindly.

`references/obscura-cli.md` has the full binary reference: `scrape` for parallel fetching, `serve` and
the CDP domains, the MCP server, and the environment variables.
