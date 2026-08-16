#!/usr/bin/env bash

set -euo pipefail

repository_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "public-repo-hygiene: not inside a Git repository" >&2
  exit 2
}
cd "$repository_root"

failure_count=0

report_failure() {
  local category="$1"
  local path="$2"

  printf 'public-repo-hygiene: forbidden %s: %s\n' "$category" "$path" >&2
  failure_count=$((failure_count + 1))
}

check_path() {
  local path="$1"
  local basename="${path##*/}"

  case "$basename" in
    .env.example)
      ;;
    .env|.env.*|.envrc)
      report_failure "secret environment file" "$path"
      ;;
  esac

  case "$basename" in
    *.db|*.db-*|*.sqlite|*.sqlite-*|*.sqlite3|*.sqlite3-*)
      report_failure "local database file" "$path"
      ;;
    *.log)
      report_failure "log file" "$path"
      ;;
    *.pem|*.key|*.p12|*.pfx)
      report_failure "credential or private-key file" "$path"
      ;;
    .DS_Store|Thumbs.db|Desktop.ini|*.swp|*~)
      report_failure "machine-local artifact" "$path"
      ;;
  esac

  case "/$path/" in
    */.codex/*|*/.local/*|*/logs/*|*/tmp/*)
      report_failure "local runtime state" "$path"
      ;;
    */node_modules/*|*/.pnpm-store/*|*/dist/*|*/coverage/*)
      report_failure "generated artifact" "$path"
      ;;
    */.idea/*|*/.vscode/*)
      report_failure "editor-local state" "$path"
      ;;
  esac
}

credential_patterns=(
  'private-key PEM header|-----BEGIN ([A-Z0-9]+ )?PRIVATE'' KEY-----'
  'GitHub token|gh''[pousr]_[A-Za-z0-9]{36,}'
  'GitHub fine-grained token|github_''pat_[A-Za-z0-9_]{50,}'
  'OpenAI-style API key|sk-''(proj-)?[A-Za-z0-9_-]{32,}'
  'AWS access key ID|(AKIA|ASIA)''[A-Z0-9]{16}'
  'Google API key|AIza''[0-9A-Za-z_-]{35}'
  'Google OAuth client secret|GOCSPX-''[0-9A-Za-z_-]{20,}'
  'Slack token|xox''[baprs]-[0-9A-Za-z-]{20,}'
  'Stripe live secret key|sk_''live_[0-9A-Za-z]{20,}'
  'npm access token|npm_''[0-9A-Za-z]{36,}'
)

check_content() {
  local path="$1"
  local entry
  local category
  local pattern

  [[ -f "$path" ]] || return

  for entry in "${credential_patterns[@]}"; do
    category="${entry%%|*}"
    pattern="${entry#*|}"
    if LC_ALL=C grep -IqE -- "$pattern" "$path"; then
      report_failure "$category signature" "$path"
    fi
  done
}

while IFS= read -r -d '' path; do
  check_path "$path"
  check_content "$path"
done < <(git ls-files -z)

if ((failure_count > 0)); then
  printf 'public-repo-hygiene: FAIL (%d finding%s)\n' \
    "$failure_count" "$([[ "$failure_count" -eq 1 ]] && printf '' || printf 's')" >&2
  exit 1
fi

echo "public-repo-hygiene: PASS"
