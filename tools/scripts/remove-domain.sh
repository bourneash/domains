#!/usr/bin/env bash
# remove-domain.sh — remove a domain integration created by bootstrap/full-bootstrap
#
# Default behavior:
#   1. Rename the GitHub repo to <domain>-archived-YYYY-MM-DD (or add HHMMSS if needed)
#   2. Archive the renamed GitHub repo
#   3. Detach Worker custom domains for apex + www
#   4. Delete the Worker script if present
#   5. Delete domain-specific CF email routing rules and disable catch-all
#   6. Remove the local git submodule and leftover .git/modules state
#
# Usage:
#   bash tools/scripts/remove-domain.sh <domain.tld>
#   bash tools/scripts/remove-domain.sh --delete-repo <domain.tld>
#   bash tools/scripts/remove-domain.sh --no-github --no-cloudflare <domain.tld>
set -euo pipefail

DELETE_REPO=0
DO_GITHUB=1
DO_CLOUDFLARE=1
DO_LOCAL=1

ARGS=()
for arg in "$@"; do
  case "${arg}" in
    --delete-repo) DELETE_REPO=1 ;;
    --no-github) DO_GITHUB=0 ;;
    --no-cloudflare) DO_CLOUDFLARE=0 ;;
    --no-local) DO_LOCAL=0 ;;
    *) ARGS+=("${arg}") ;;
  esac
done
set -- "${ARGS[@]}"

DOMAIN="${1:?Usage: $0 [--delete-repo] [--no-github] [--no-cloudflare] [--no-local] <domain.tld>}"
WORKER_NAME="${DOMAIN//./-}"
GITHUB_OWNER="${GITHUB_OWNER:-bourneash}"
GITHUB_REPO="${GITHUB_OWNER}/${DOMAIN}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAINS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SUBMODULE_PATH="sites/${DOMAIN}"
ARCHIVE_DATE="$(date +%F)"
ARCHIVE_STAMP="$(date +%F-%H%M%S)"
DEST="jessetamburino@hotmail.com"

log() {
  echo "$@"
}

require_env() {
  set -a
  . "${DOMAINS_ROOT}/.env"
  set +a
}

json_value() {
  local expr="$1"
  # DELETE responses can come back empty/non-JSON (e.g. 204 No Content) even
  # on success — treat that as "no data to report" instead of a crash so the
  # caller's status line stays readable.
  python3 -c "
import json, sys
raw = sys.stdin.read()
try:
    data = json.loads(raw) if raw.strip() else {}
except Exception:
    data = {}
${expr}
"
}

cf_get() {
  local url="$1"
  curl -sS --max-time 30 "${url}" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
}

cf_send() {
  local method="$1"
  local url="$2"
  local body="${3:-}"

  if [ -n "${body}" ]; then
    curl -sS --max-time 30 -X "${method}" "${url}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "${body}"
  else
    curl -sS --max-time 30 -X "${method}" "${url}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
  fi
}

archive_or_delete_repo() {
  if ! gh repo view "${GITHUB_REPO}" --json nameWithOwner >/dev/null 2>&1; then
    log "--- GitHub repo absent: ${GITHUB_REPO} ---"
    return 0
  fi

  if [ "${DELETE_REPO}" = "1" ]; then
    log "--- Deleting GitHub repo: ${GITHUB_REPO} ---"
    gh repo delete "${GITHUB_REPO}" --yes
    return 0
  fi

  local archive_name="${DOMAIN}-archived-${ARCHIVE_DATE}"
  if gh repo view "${GITHUB_OWNER}/${archive_name}" --json nameWithOwner >/dev/null 2>&1; then
    archive_name="${DOMAIN}-archived-${ARCHIVE_STAMP}"
  fi

  log "--- Renaming GitHub repo: ${GITHUB_REPO} -> ${GITHUB_OWNER}/${archive_name} ---"
  gh repo rename -R "${GITHUB_REPO}" "${archive_name}" -y

  log "--- Archiving GitHub repo: ${GITHUB_OWNER}/${archive_name} ---"
  gh repo archive "${GITHUB_OWNER}/${archive_name}" -y
}

cloudflare_remove_email() {
  local zone_id="$1"
  local rules_json
  rules_json="$(cf_get "https://api.cloudflare.com/client/v4/zones/${zone_id}/email/routing/rules")"

  mapfile -t rule_ids < <(
    printf '%s' "${rules_json}" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for rule in data.get("result", []):
    for matcher in rule.get("matchers", []):
        if matcher.get("field") == "to" and matcher.get("value", "").endswith("@'"${DOMAIN}"'"):
            print(rule["id"])
            break
'
  )

  if [ "${#rule_ids[@]}" -eq 0 ]; then
    log "--- No domain-specific email routing rules found for ${DOMAIN} ---"
  else
    for rule_id in "${rule_ids[@]}"; do
      local resp
      resp="$(cf_send DELETE "https://api.cloudflare.com/client/v4/zones/${zone_id}/email/routing/rules/${rule_id}")"
      log "  email rule ${rule_id}: $(printf '%s' "${resp}" | json_value 'print("OK" if data.get("success") else data.get("errors"))')"
    done
  fi

  local catchall_body
  catchall_body='{"name":"catch-all disabled","enabled":false,"matchers":[{"type":"all"}],"actions":[{"type":"drop"}]}'
  local catchall_resp
  catchall_resp="$(cf_send PUT "https://api.cloudflare.com/client/v4/zones/${zone_id}/email/routing/rules/catch_all" "${catchall_body}")"
  log "  catch-all: $(printf '%s' "${catchall_resp}" | json_value 'print("disabled" if data.get("success") else data.get("errors"))')"
}

cloudflare_remove_worker_domains() {
  local host
  for host in "${DOMAIN}" "www.${DOMAIN}"; do
    local resp
    resp="$(cf_get "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains?environment=production&hostname=${host}")"

    mapfile -t domain_ids < <(
      printf '%s' "${resp}" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for item in data.get("result", []):
    print(item["id"])
'
    )

    if [ "${#domain_ids[@]}" -eq 0 ]; then
      log "  worker domain ${host}: absent"
      continue
    fi

    local domain_id
    for domain_id in "${domain_ids[@]}"; do
      local delete_resp
      delete_resp="$(cf_send DELETE "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains/${domain_id}")"
      log "  worker domain ${host} (${domain_id}): $(printf '%s' "${delete_resp}" | json_value 'print("detached" if data.get("success") else data.get("errors"))')"
    done
  done
}

cloudflare_remove_worker_script() {
  local tmp_body
  tmp_body="$(mktemp)"
  local http_code
  http_code="$(
    curl -sS --max-time 30 -o "${tmp_body}" -w '%{http_code}' \
      -X DELETE "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
  )"

  case "${http_code}" in
    200|202|204)
      log "  worker script ${WORKER_NAME}: deleted"
      ;;
    404)
      log "  worker script ${WORKER_NAME}: absent"
      ;;
    *)
      log "  worker script ${WORKER_NAME}: HTTP ${http_code}"
      sed -n '1,120p' "${tmp_body}"
      rm -f "${tmp_body}"
      return 1
      ;;
  esac

  rm -f "${tmp_body}"
}

remove_local_submodule() {
  # A domain disabled via the sites/DISABLED-<domain> rename convention keeps
  # its real content (and .git gitlink) at that path, while sites/<domain>
  # can still exist separately as a stale husk (e.g. a leftover directory
  # from before the rename, sometimes root-owned). Check both so disabling a
  # site doesn't strand its real directory here forever.
  local disabled_path="sites/DISABLED-${DOMAIN}"
  local candidate_paths=("${SUBMODULE_PATH}")
  [ -d "${disabled_path}" ] && candidate_paths+=("${disabled_path}")

  local p
  for p in "${candidate_paths[@]}"; do
    if git ls-files --error-unmatch -- "${p}" >/dev/null 2>&1; then
      log "--- Removing tracked path: ${p} ---"
      git submodule deinit -f -- "${p}" || true
      git rm -f -- "${p}"
    elif [ -d "${p}" ]; then
      log "--- Removing untracked path: ${p} ---"
      rm -rf "${p}"
    else
      log "--- Local path already absent: ${p} ---"
    fi

    if git config -f .gitmodules --get "submodule.${p}.path" >/dev/null 2>&1; then
      log "--- Removing lingering .gitmodules section for ${p} ---"
      git config -f .gitmodules --remove-section "submodule.${p}" || true
    fi

    # `git submodule deinit` only clears the WORKING TREE's copy of the
    # submodule's config; the section it copied into the superproject's own
    # .git/config on init can outlive both a deinit and a later .gitmodules
    # removal if nothing ever ran `git config --remove-section` on it too.
    if git config --get "submodule.${p}.url" >/dev/null 2>&1; then
      log "--- Removing lingering .git/config section for ${p} ---"
      git config --remove-section "submodule.${p}" || true
    fi
  done

  # The git module dir is keyed by the submodule's ORIGINAL registered path
  # (SUBMODULE_PATH), even if the working-tree directory was later renamed to
  # the DISABLED- form — core.worktree inside it still points at whichever
  # path was current when it was initialized.
  if [ -d "${DOMAINS_ROOT}/.git/modules/${SUBMODULE_PATH}" ]; then
    log "--- Removing leftover git module state: .git/modules/${SUBMODULE_PATH} ---"
    rm -rf "${DOMAINS_ROOT}/.git/modules/${SUBMODULE_PATH}"
  fi
}

# remove_local_submodule() drives git with RELATIVE paths (`git ls-files --
# sites/<domain>`, `git rm`, `git config -f .gitmodules`), so every one of them
# silently resolves against the caller's cwd. Run from anywhere but the repo
# root — a cron, a container, the Fleet Dashboard's job runner — and the local
# cleanup reported "Local path already absent" and did NOTHING, while the
# absolute-path `.git/modules/<path>` removal at the end of that function still
# fired. Net effect: the submodule directory survived with a .git file pointing
# at a gitdir that no longer existed, which made `git status` fail fatally for
# the WHOLE parent repo. Caught 2026-08-15 by an end-to-end offboard test.
# bootstrap-domain.sh already cd's here before its `git submodule add` for the
# same reason; this makes the teardown side symmetric.
cd "${DOMAINS_ROOT}"

log ""
log "=== remove-domain.sh: ${DOMAIN} ==="
log "  Worker name : ${WORKER_NAME}"
log "  GitHub repo : ${GITHUB_REPO}"
log ""

if [ "${DO_GITHUB}" = "1" ] || [ "${DO_CLOUDFLARE}" = "1" ]; then
  require_env
fi

if [ "${DO_GITHUB}" = "1" ]; then
  archive_or_delete_repo
fi

if [ "${DO_CLOUDFLARE}" = "1" ]; then
  zone_json="$(cf_get "https://api.cloudflare.com/client/v4/zones?name=${DOMAIN}")"
  zone_id="$(printf '%s' "${zone_json}" | json_value 'items=data.get("result", []); print(items[0]["id"] if items else "")')"

  # Worker scripts and worker custom-domain bindings are ACCOUNT-scoped, not
  # zone-scoped — both API paths are /accounts/<id>/workers/..., and neither
  # takes a zone id. They used to sit inside the `else` branch below, which
  # meant offboarding a domain whose zone had already been removed from
  # Cloudflare silently ORPHANED its Worker: the script reported "zone absent"
  # and exited 0 with the Worker still deployed and serving. Caught 2026-08-15
  # by an end-to-end onboard/offboard test on a throwaway domain that never had
  # a zone. Only the EMAIL cleanup genuinely needs a zone.
  cloudflare_remove_worker_domains
  cloudflare_remove_worker_script

  if [ -z "${zone_id}" ]; then
    log "--- Cloudflare zone absent: ${DOMAIN} (skipping email routing cleanup) ---"
  else
    log "--- Cloudflare zone: ${zone_id} ---"
    cloudflare_remove_email "${zone_id}"
  fi
fi

if [ "${DO_LOCAL}" = "1" ]; then
  remove_local_submodule
fi

log ""
log "=== remove-domain complete: ${DOMAIN} ==="
