#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is required but not installed" >&2
  exit 1
fi

compose_file="${COMPOSE_FILE:-docker-compose.integration.yml}"
declare -a compose_cmd

active_context="$(docker context show 2>/dev/null || true)"
if [ -n "$active_context" ]; then
  active_endpoint="$(docker context inspect "$active_context" --format '{{(index .Endpoints "docker").Host}}' 2>/dev/null || true)"
  if [ -n "$active_endpoint" ]; then
    export DOCKER_HOST="$active_endpoint"
  fi
fi

docker_config_dir="${DOCKER_CONFIG:-$HOME/.docker}"
docker_config_file="$docker_config_dir/config.json"
temp_docker_config=""

cleanup() {
  if [ -n "$temp_docker_config" ] && [ -d "$temp_docker_config" ]; then
    rm -rf "$temp_docker_config"
  fi
}
trap cleanup EXIT

if [ -f "$docker_config_file" ]; then
  creds_store="$(sed -n 's/.*"credsStore"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$docker_config_file" | head -n 1)"
  if [ -n "$creds_store" ] && ! command -v "docker-credential-$creds_store" >/dev/null 2>&1; then
    temp_docker_config="$(mktemp -d)"
    cat >"$temp_docker_config/config.json" <<'EOF'
{
  "auths": {}
}
EOF
    export DOCKER_CONFIG="$temp_docker_config"
    echo "warning: missing docker-credential-$creds_store; using temporary Docker config for this run" >&2
  fi
fi

if command -v docker-compose >/dev/null 2>&1; then
  compose_cmd=(docker-compose)
elif docker compose version >/dev/null 2>&1; then
  compose_cmd=(docker compose)
else
  echo "error: docker compose is required but not available" >&2
  exit 1
fi

runtime_dir="${HERD_RUNTIME_DIR:-/workspace/tmp}"
mkdir -p tmp

"${compose_cmd[@]}" -f "$compose_file" build integration-tests
"${compose_cmd[@]}" -f "$compose_file" run --rm \
  -e HERD_RUNTIME_DIR="$runtime_dir" \
  -e TMPDIR="$runtime_dir" \
  integration-tests "$@"
