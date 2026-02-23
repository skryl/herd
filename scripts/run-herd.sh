#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is required but not installed" >&2
  exit 1
fi

compose_file="${COMPOSE_FILE:-docker-compose.integration.yml}"
socket="${HERD_DOCKER_TMUX_SOCKET:-herd}"
host_config_dir="${HERD_HOST_CONFIG_DIR:-$HOME/.config/herd}"
container_config_dir="${HERD_CONTAINER_CONFIG_DIR:-/root/.config/herd}"
host_codex_dir="${HERD_HOST_CODEX_DIR:-$HOME/.codex}"
container_codex_dir="${HERD_CONTAINER_CODEX_DIR:-/root/.codex}"
host_runtime_dir="${HERD_HOST_RUNTIME_DIR:-$PWD/tmp}"
container_runtime_dir="${HERD_CONTAINER_RUNTIME_DIR:-/workspace/tmp}"
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

mkdir -p "$host_config_dir"
mkdir -p "$host_codex_dir"
mkdir -p "$host_runtime_dir"

"${compose_cmd[@]}" -f "$compose_file" build integration-tests
"${compose_cmd[@]}" -f "$compose_file" run --rm \
  -v "$host_config_dir:$container_config_dir" \
  -v "$host_codex_dir:$container_codex_dir" \
  -v "$host_runtime_dir:$container_runtime_dir" \
  -e HERD_RUNTIME_DIR="$container_runtime_dir" \
  -e TMPDIR="$container_runtime_dir" \
  -e HERD_CONFIG="$container_config_dir/settings.json" \
  -e HERD_STATE="$container_config_dir/state.json" \
  -e OPENAI_API_KEY \
  -e ANTHROPIC_API_KEY \
  --entrypoint /workspace/scripts/run-herd-container-entrypoint.sh \
  integration-tests "$socket" "$@"
