#! /bin/bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(realpath "${script_dir}/../..")"
data_path="${root_dir}/build/magic-mirror-data"
CONTAINER_ENGINE=${CONTAINER_ENGINE:-docker}

function build_image() {
  ${CONTAINER_ENGINE} build -t magic-mirror "${root_dir}"
}

function setup_config() {
  mkdir -p "${data_path}"
  cp "${root_dir}/src/fixtures/mock-cert.pem" "${data_path}/auth.key"
  cat <<EOF >"${data_path}/config.json"
{
  "appID": 2,
  "dbPath": "/etc/magic-mirror/magic-mirror.db",
  "logLevel": "info",
  "privateKeyPath": "/etc/magic-mirror/auth.key",
  "syncInterval": 30,
  "upstreamMappings": {},
  "webhookSecret": "my-secret"
}
EOF
}

function run_syncer() {
  output=$(${CONTAINER_ENGINE} run --rm --entrypoint="" magic-mirror npm run syncer 2>&1 || true)
  if ! (echo "$output" | grep -q 'throw new Error("No config.json could be found")'); then
    echo '❌ Syncer failed to start'
    echo '::group::Syncer debug'
    printf 'Expected "No config.json could be found" error, but got:\n%s\n' "${output}"
    echo "::endgroup::"
    return 1
  else
    echo "✅ Syncer started successfully"
  fi
}

function run_webhook_listener() {
  local exit_code=0
  ${CONTAINER_ENGINE} run --detach --name=webhook-listener --entrypoint="" \
    -v="${data_path}:/etc/magic-mirror:Z" \
    magic-mirror npm run web 1>/dev/null
  
  echo "Waiting for webhook listener to start..."
  for i in $(seq 1 10); do
    response=$(${CONTAINER_ENGINE} exec webhook-listener curl -s localhost:3000/status) ||
      {
        echo "Connection to webhook listener failed. Retrying (${i}/10)"
        sleep 1
      }
  done

  if [ "${response}" != "OK" ]; then
    printf '❌ Webhook listener failed to start\n  Expected "OK" response, but got:\n%s\n' "${response}"
    echo '::group::Webhook listener debug'
    printf "Container logs:\n%s\n" "$(${CONTAINER_ENGINE} logs webhook-listener)"
    echo "::endgroup::"
    exit_code=1
  else
    echo "✅ Webhook listener started successfully"
  fi

  ${CONTAINER_ENGINE} rm -f webhook-listener &>/dev/null || true
  rm -rf "${data_path}"

  return ${exit_code}
}

function test_container_image() {
  local exit_code=0
  setup_config
  run_syncer || exit_code=1
  run_webhook_listener || exit_code=1
  return ${exit_code}
}

if [ $# -eq 0 ]; then
  echo "Usage: $0 <function>"
  echo "Functions:"
  echo "  build"
  echo "  setup_config"
  echo "  run_syncer"
  echo "  run_webhook_listener"
  echo "  test_container_image"
  exit 1
fi

${1}
