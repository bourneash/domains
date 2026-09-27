#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${EXECUTIVE_SMOKE_IMAGE:-domains-executive-runner:smoke}"
BASE_IMAGE_ID="$(docker image inspect --format '{{.Id}}' domain-developer:latest)"

node --test "$ROOT/tools/executive/image-manifest.test.js"
docker build --build-arg "EXECUTIVE_BASE_IMAGE=domain-developer:latest" \
  --label "com.bourneash.executive.base-image-id=$BASE_IMAGE_ID" \
  -f "$ROOT/tools/executive/Dockerfile" -t "$IMAGE" "$ROOT"
docker run --rm --entrypoint node "$IMAGE" \
  -e "require('/app/tools/executive/model-runner.js'); console.log('executive model runner imports OK')"
