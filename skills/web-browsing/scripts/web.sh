#!/usr/bin/env bash
# One-shot web access through the Obscura headless browser.
#
#   web.sh search QUERY [-n N]
#   web.sh read URL [mode] [flags]      # page -> file + short preview
#                modes: (default) markdown, --text, --links, --html, --raw
#                --raw is the response body verbatim, no browser: JSON, APIs, files
#                flags: --selector CSS, --wait S, --timeout S, --stealth, --robots,
#                       -o PATH, --print (the whole file to stdout, no preview)
#   web.sh eval URL EXPR
#   web.sh shot URL [PATH]
#   web.sh doctor
#
# Page dumps are written to $WEB_CACHE_DIR (default: $TMPDIR/web-browsing) and only
# a bounded preview goes to stdout, so the caller reads the file with read/grep
# instead of pushing a whole page into the model context.
#
# Env: OBSCURA_BIN path to the binary, WEB_CACHE_DIR output directory,
#      WEB_PREVIEW_CHARS preview size (default 2500).
set -uo pipefail

CACHE_DIR="${WEB_CACHE_DIR:-${TMPDIR:-/tmp}/web-browsing}"
PREVIEW="${WEB_PREVIEW_CHARS:-2500}"

die() {
  printf 'web.sh: %s\n' "$*" >&2
  exit 1
}

obscura_bin() {
  if [[ -n "${OBSCURA_BIN:-}" ]]; then
    [[ -x "$OBSCURA_BIN" ]] || die "OBSCURA_BIN=$OBSCURA_BIN is not executable"
    printf '%s\n' "$OBSCURA_BIN"
    return
  fi
  local candidate
  for candidate in \
    "$(command -v obscura 2>/dev/null)" \
    "$HOME/Apps/obscura/obscura" \
    "$HOME/.local/bin/obscura" \
    "/usr/local/bin/obscura"; do
    [[ -n "$candidate" && -x "$candidate" ]] && {
      printf '%s\n' "$candidate"
      return
    }
  done
  die "obscura not found; set OBSCURA_BIN or put it on PATH"
}

urlencode() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1]).replace(/%20/g, "+"))' "$1"
}

# Keep names short, stable, and readable enough to grep for.
cache_path() {
  local url=$1 ext=$2 host path slug
  host=${url#*://}
  host=${host%%/*}
  host=${host##*@}
  host=${host%%:*}
  path=${url#*://}
  path=${path#*/}
  slug=$(printf '%s' "$path" | tr -cs 'a-zA-Z0-9' '-' | cut -c1-60 | sed 's/^-*//; s/-*$//')
  printf '%s/%s%s%s-%s.%s\n' "$CACHE_DIR" "${host:-page}" "${slug:+-}" "$slug" "$(printf '%s' "$url" | cksum | cut -d' ' -f1)" "$ext"
}

report_file() {
  local path=$1 chars=${2:-$PREVIEW} lines bytes
  bytes=$(wc -c <"$path")
  lines=$(awk 'END { print NR }' "$path")
  printf 'saved %s lines, %s bytes -> %s\n' "$lines" "$bytes" "$path"
  if ((bytes > chars)); then
    head -c "$chars" "$path"
    printf '\n[... truncated; read or grep %s for the rest]\n' "$path"
  else
    cat "$path"
  fi
}

cmd=${1:-}
shift || true

case "$cmd" in
  search)
    query=""
    n=8
    rest=()
    while (($#)); do
      case "$1" in
        -n) n=$2 && shift 2 ;;
        -*) rest+=("$1") && shift ;;
        *) query+="${query:+ }$1" && shift ;;
      esac
    done
    [[ -n "$query" ]] || die "usage: web.sh search QUERY [-n N]"
    url="https://lite.duckduckgo.com/lite/?q=$(urlencode "$query")"
    expr="JSON.stringify([...document.querySelectorAll('a.result-link')].map(a=>({t:a.textContent.trim(),u:new URL(a.href).searchParams.get('uddg')||a.href,s:(a.closest('tr')?.nextElementSibling?.textContent||'').trim().replace(/\s+/g,' ')})).slice(0,$n))"
    results=$("$(obscura_bin)" fetch "$url" -q --timeout 25 --eval "$expr" "${rest[@]}" 2>&1) ||
      die "search failed: $(printf '%s' "$results" | tail -1)"
    printf '%s' "$results" | node -e '
      let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
        let rs; try { rs=JSON.parse(d); } catch { console.error("web.sh: could not parse search results"); process.exit(1); }
        if (!rs.length) { console.error("web.sh: no results"); process.exit(1); }
        rs.forEach((r,i)=>{ console.log(`${i+1}. ${r.t}`); console.log(`   ${r.u}`); if (r.s) console.log(`   ${r.s.slice(0,220)}`); });
      });' || die "no results for: $query"
    ;;

  read | fetch)
    url=""
    mode=markdown
    out=""
    args=()
    while (($#)); do
      case "$1" in
        --raw | -r) mode=original && shift ;;
        --links | -l) mode=links && shift ;;
        --text | -t) mode=text && shift ;;
        --html | -H) mode=html && shift ;;
        --selector) args+=(--selector "$2") && shift 2 ;;
        --wait) args+=(--wait "$2") && shift 2 ;;
        --timeout) args+=(--timeout "$2") && shift 2 ;;
        --stealth) args+=(--stealth) && shift ;;
        --robots) args+=(--obey-robots) && shift ;;
        --print | -p) mode_stdout=1 && shift ;;
        -o) out=$2 && shift 2 ;;
        -*) die "unknown flag: $1" ;;
        *) url=$1 && shift ;;
      esac
    done
    [[ -n "$url" ]] || die "usage: web.sh read URL [--raw|--links|--text|--html] [--selector CSS] [-o PATH] [--print]"
    mkdir -p "$CACHE_DIR"
    [[ -n "$out" ]] || {
      case "$mode" in
        original) ext=bin ;;
        links) ext=tsv ;;
        text) ext=txt ;;
        html) ext=html ;;
        *) ext=md ;;
      esac
      out=$(cache_path "$url" "$ext")
    }
    # --dump original is binary-safe and skips the JS layer; everything else is rendered.
    [[ "$mode" == original ]] && args+=(--dump original) || args+=(--dump "$mode")
    "$(obscura_bin)" fetch "$url" -q "${args[@]}" -o "$out" || die "fetch failed: $url"
    if [[ -n "${mode_stdout:-}" ]]; then
      cat "$out"
    elif [[ "$mode" == original ]]; then
      # JSON and other small machine-readable bodies are more useful inline than as a stub.
      report_file "$out" "${WEB_PREVIEW_CHARS_RAW:-8000}"
    else
      report_file "$out"
    fi
    ;;

  eval)
    url=${1:-}
    expr=${2:-}
    [[ -n "$url" && -n "$expr" ]] || die "usage: web.sh eval URL 'JS expression'"
    shift 2
    "$(obscura_bin)" fetch "$url" -q --timeout 25 --eval "$expr" "$@" || die "eval failed: $url"
    ;;

  shot | screenshot)
    url=${1:-}
    [[ -n "$url" ]] || die "usage: web.sh shot URL [PATH]"
    mkdir -p "$CACHE_DIR"
    out=${2:-$(cache_path "$url" png)}
    "$(obscura_bin)" fetch "$url" -q --timeout 30 -s "$out" || die "screenshot failed: $url"
    printf 'screenshot (%s bytes) -> %s\n' "$(wc -c <"$out")" "$out"
    ;;

  doctor)
    bin=$(obscura_bin) || exit 1
    printf 'obscura: %s\nversion: %s\ncache: %s\n' "$bin" "$("$bin" --version)" "$CACHE_DIR"
    ;;

  *)
    # The header comment of this file is its usage text.
    awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } !NF { print; next } { exit }' "$0"
    exit 2
    ;;
esac
