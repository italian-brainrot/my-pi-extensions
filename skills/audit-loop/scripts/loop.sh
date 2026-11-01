#!/usr/bin/env bash
# Orientation for one pass of an audit loop, so a fresh session reads the state of the loop instead of
# reconstructing it from a 3000-line log.
#
#   loop.sh status REPO            git state + every pass in the audit log + the status bullet
#   loop.sh pass REPO [HEADING]    print one log section (default: the newest "## Pass" one)
#   loop.sh strays [PATTERN]       processes a pass left behind; exits 1 if it finds any
#
# It deliberately does not run the gate: the counts come from the handoff prompt, and the agent is supposed
# to re-measure them itself.

set -u

usage() {
  cat <<'TXT'
usage: loop.sh status REPO | pass REPO [HEADING] | strays [PATTERN]

  status REPO          git state, every pass in the audit log, and the MEMORY.md status bullet
  pass REPO [HEADING]  print one audit-log section (default: the newest "## Pass" one)
  strays [PATTERN]     processes a pass left behind; exits 1 if it finds any
TXT
  exit 2
}

find_audit() {
  local candidate
  for candidate in "$1/docs/AUDIT.md" "$1/AUDIT.md" "$1/docs/audit.md"; do
    [ -f "$candidate" ] && { echo "$candidate"; return; }
  done
  echo ""
}

[ $# -lt 1 ] && usage
cmd=$1
shift

case "$cmd" in
  status)
    [ $# -lt 1 ] && usage
    repo=${1%/}
    [ -d "$repo" ] || { echo "not a directory: $repo" >&2; exit 2; }
    echo "== $repo"
    if git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
      echo "branch  $(git -C "$repo" rev-parse --abbrev-ref HEAD)"
      echo "head    $(git -C "$repo" log --oneline -1)"
      if upstream=$(git -C "$repo" rev-parse --abbrev-ref '@{upstream}' 2>/dev/null); then
        echo "remote  $upstream (behind ahead: $(git -C "$repo" rev-list --left-right --count "${upstream}...HEAD" 2>/dev/null))"
      else
        echo "remote  no upstream"
      fi
      dirty=$(git -C "$repo" status --porcelain | wc -l | tr -d ' ')
      echo "dirty   ${dirty} path(s)"
      [ "$dirty" != 0 ] && git -C "$repo" status --porcelain | head -12 | sed 's/^/  /'
      echo "recent"
      git -C "$repo" log --oneline -6 | sed 's/^/  /'
    else
      echo "not a git repository"
    fi

    audit=$(find_audit "$repo")
    if [ -n "$audit" ]; then
      echo "== audit log: ${audit#"$repo/"} ($(wc -l <"$audit") lines)"
      awk '
        /^## / { if (sec != "") printf "  %-56s %d finding(s)\n", sec, n; sec = substr($0, 4); n = 0; next }
        /^### R[0-9]+-[0-9]+/ { n++ }
        END { if (sec != "") printf "  %-56s %d finding(s)\n", sec, n }
      ' "$audit"
      last=$(grep -n '^## ' "$audit" | tail -1 | cut -d: -f1)
      gates=$(tail -n +"$last" "$audit" | grep -iE '^(Gate|Baseline)' | head -6)
      if [ -n "$gates" ]; then
        echo "== gate lines from the newest section"
        echo "$gates" | sed 's/^/  /'
      fi
      echo "Read the newest section in full before anything else: loop.sh pass \"$repo\""
    else
      echo "== no audit log yet (expected $repo/docs/AUDIT.md)"
    fi

    if [ -f "$repo/MEMORY.md" ]; then
      start=$(grep -n -i 'audit loop' "$repo/MEMORY.md" | head -1 | cut -d: -f1)
      if [ -n "$start" ]; then
        echo "== status bullet in MEMORY.md"
        tail -n +"$start" "$repo/MEMORY.md" | awk 'NR > 1 && /^[-*] / { exit } { print "  " $0 }' | head -40
      fi
    fi
    ;;

  pass)
    [ $# -lt 1 ] && usage
    repo=${1%/}
    audit=$(find_audit "$repo")
    [ -n "$audit" ] || { echo "no audit log (expected $repo/docs/AUDIT.md)" >&2; exit 2; }
    want=${2:-}
    if [ -z "$want" ]; then
      want=$(grep '^## Pass' "$audit" | tail -1 | sed 's/^## //')
      [ -n "$want" ] || { echo "no '## Pass' section in $audit; pass a heading substring" >&2; exit 1; }
    fi
    echo "== ${audit#"$repo/"} :: $want"
    awk -v want="$want" '
      /^## / { keep = (index($0, want) > 0) }
      keep { print }
    ' "$audit"
    ;;

  strays)
    pattern=${1:-}
    found=0
    echo "== orphans pinned above 90% CPU (PPID 1, so a GUI monitor will not show them)"
    orphans=$(ps -eo pid,ppid,pcpu,etimes,args --sort=-pcpu --no-headers 2>/dev/null | awk '$2 == 1 && $3 > 90 { printf "  %7s %8s %6s %s\n", $1, $3, $4, substr($0, index($0, $5), 160) }' | head -10)
    if [ -n "$orphans" ]; then
      echo "$orphans"
      found=1
    else
      echo "  none"
    fi
    if [ -n "$pattern" ]; then
      # Everything sharing our process group is this command's own pipeline (ps, awk, the subshell), and a
      # job in our group dies with the job that started it, so it is not a stray.
      pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
      echo "== processes matching: $pattern (this command's own process group excluded)"
      matches=$(ps -eo pid,pcpu,etimes,pgid,args --no-headers 2>/dev/null | awk -v pat="$pattern" -v pgid="$pgid" '
        index($0, pat) && $4 != pgid { printf "  %7s %8s %6s %s\n", $1, $2, $3, substr($0, index($0, $5), 160); f++ }
        END { if (!f) print "NONE" }')
      if [ "$matches" = "NONE" ]; then
        echo "  none"
      else
        echo "$matches" | head -20
        found=1
      fi
    fi
    if [ "$found" = 1 ]; then
      echo
      echo "Kill what this pass started. Next time start the script with"
      echo "  trap 'kill \$(jobs -p) 2>/dev/null' EXIT INT TERM"
      echo "because \$! holds one pid, not the 24 jobs you launched."
      exit 1
    fi
    ;;

  *)
    usage
    ;;
esac
