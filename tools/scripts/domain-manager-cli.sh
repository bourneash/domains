#!/usr/bin/env bash
# domain-manager-cli.sh — menu-driven and CLI-driven domain operations
#
# Default add flow:
#   1. bootstrap-domain.sh
#   2. deploy from sites/<domain>/site
#   3. bind-worker-domain.sh
#
# Examples:
#   tools/scripts/domain-manager-cli.sh
#   tools/scripts/domain-manager-cli.sh menu
#   tools/scripts/domain-manager-cli.sh add example.com
#   tools/scripts/domain-manager-cli.sh add example.com --bootstrap-only
#   tools/scripts/domain-manager-cli.sh remove example.com
#   tools/scripts/domain-manager-cli.sh status example.com
#   tools/scripts/domain-manager-cli.sh repair example.com
#   tools/scripts/domain-manager-cli.sh deploy example.com
#   tools/scripts/domain-manager-cli.sh bind example.com
#   tools/scripts/domain-manager-cli.sh email example.com
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAINS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [ -t 1 ] && [ "${NO_COLOR:-0}" != "1" ] && [ "${TERM:-}" != "dumb" ]; then
  COLOR_RED=$'\033[31m'
  COLOR_GREEN=$'\033[32m'
  COLOR_YELLOW=$'\033[33m'
  COLOR_BLUE=$'\033[34m'
  COLOR_BOLD=$'\033[1m'
  COLOR_RESET=$'\033[0m'
else
  COLOR_RED=""
  COLOR_GREEN=""
  COLOR_YELLOW=""
  COLOR_BLUE=""
  COLOR_BOLD=""
  COLOR_RESET=""
fi

usage() {
  cat <<'EOF'
Usage:
  domain-manager-cli.sh
  domain-manager-cli.sh menu
  domain-manager-cli.sh add <domain.tld> [--bootstrap-only] [--no-deploy] [--no-bind] [--no-email]
  domain-manager-cli.sh add <domain.tld> --full [--no-email]
  domain-manager-cli.sh remove <domain.tld> [--delete-repo] [--no-github] [--no-cloudflare] [--no-local]
  domain-manager-cli.sh status <domain.tld>
  domain-manager-cli.sh repair <domain.tld> [--plan] [--no-email] [--no-deploy] [--no-bind]
  domain-manager-cli.sh deploy <domain.tld>
  domain-manager-cli.sh bind <domain.tld>
  domain-manager-cli.sh email <domain.tld>
  domain-manager-cli.sh bootstrap <domain.tld> [--no-email]
  domain-manager-cli.sh help

Commands:
  menu       Launch interactive menu.
  add        Add a domain. Default flow is bootstrap -> deploy -> bind.
  remove     Remove a domain using remove-domain.sh.
  status     Report local, GitHub, and Cloudflare state for a domain.
  repair     Repair an incomplete domain setup by running missing next steps.
  deploy     Run npm deploy for an existing site checkout.
  bind       Bind apex + www to the Worker.
  email      Configure Cloudflare Email Routing for the domain.
  bootstrap  Run bootstrap-domain.sh only.

Add flags:
  --full            Use add-domain.sh --full.
  --bootstrap-only  Stop after bootstrap.
  --no-deploy       Skip deploy step after bootstrap.
  --no-bind         Skip bind step after deploy.
  --no-email        Pass through to bootstrap/full bootstrap.

Remove flags:
  --delete-repo
  --no-github
  --no-cloudflare
  --no-local

Repair flags:
  --plan         Print the repair plan only; do not execute.
  --no-email     Skip email-routing repair.
  --no-deploy    Skip deploy repair.
  --no-bind      Skip bind repair.
EOF
}

require_env() {
  if [ ! -f "${DOMAINS_ROOT}/.env" ]; then
    echo "ERROR: ${DOMAINS_ROOT}/.env not found" >&2
    exit 1
  fi

  set -a
  . "${DOMAINS_ROOT}/.env"
  set +a
}

ensure_domain_arg() {
  if [ "$#" -lt 1 ] || [ -z "${1:-}" ]; then
    echo "ERROR: domain argument required" >&2
    usage
    exit 1
  fi
}

run_bootstrap() {
  local domain="$1"
  shift
  bash "${SCRIPT_DIR}/bootstrap-domain.sh" "$@" "${domain}"
}

run_add_full() {
  local domain="$1"
  shift
  bash "${SCRIPT_DIR}/add-domain.sh" --full "$@" "${domain}"
}

run_deploy() {
  local domain="$1"
  require_env
  npm --prefix "${DOMAINS_ROOT}/sites/${domain}/site" run deploy
}

run_bind() {
  local domain="$1"
  bash "${SCRIPT_DIR}/bind-worker-domain.sh" "${domain}"
}

run_email() {
  local domain="$1"
  bash "${SCRIPT_DIR}/setup-cf-email.sh" "${domain}"
}

run_remove() {
  local domain="$1"
  shift
  bash "${SCRIPT_DIR}/remove-domain.sh" "$@" "${domain}"
}

run_site_install() {
  local domain="$1"
  require_env
  if [ -f "${DOMAINS_ROOT}/sites/${domain}/site/package-lock.json" ]; then
    npm --prefix "${DOMAINS_ROOT}/sites/${domain}/site" ci
  else
    npm --prefix "${DOMAINS_ROOT}/sites/${domain}/site" install
  fi
}

emit_cf_build_setup_notice() {
  local domain="$1"
  local worker_name="${domain//./-}"
  local github_repo="bourneash/${domain}"
  local build_command="npm run build"
  local deploy_command="npx wrangler deploy --config dist/client/wrangler.json"
  local version_command="npx wrangler versions upload --config dist/client/wrangler.json"
  local site_dir="${DOMAINS_ROOT}/sites/${domain}/site"

  if [ -f "${site_dir}/package.json" ]; then
    deploy_command="$(python3 -c '
import json, sys
data = json.load(open(sys.argv[1]))
deploy = data.get("scripts", {}).get("deploy", "")
if "&&" in deploy:
    deploy = deploy.split("&&", 1)[1].strip()
if deploy.startswith("wrangler "):
    deploy = "npx " + deploy
print(deploy or "npx wrangler deploy --config dist/client/wrangler.json")
' "${site_dir}/package.json")"

    version_command="$(python3 -c '
import json, sys
data = json.load(open(sys.argv[1]))
deploy = data.get("scripts", {}).get("deploy", "")
if "&&" in deploy:
    deploy = deploy.split("&&", 1)[1].strip()
if deploy.startswith("wrangler "):
    deploy = "npx " + deploy
config_path = "dist/client/wrangler.json"
parts = deploy.split()
for idx, token in enumerate(parts):
    if token == "--config" and idx + 1 < len(parts):
        config_path = parts[idx + 1]
        break
print(f"npx wrangler versions upload --config {config_path}")
' "${site_dir}/package.json")"
  fi

  echo "============================================================"
  printf '%sMANUAL CLOUDFLARE WORKER BUILDS SETUP NEEDED%s\n' "${COLOR_BOLD}${COLOR_YELLOW}" "${COLOR_RESET}"
  print_line "Worker" "${worker_name}"
  print_line "Repo" "${github_repo}"
  echo
  echo "In Cloudflare:"
  echo "  1. Open Workers & Pages -> ${worker_name}"
  echo "  2. Open Settings -> Build"
  echo "  3. Connect the GitHub repository: ${github_repo}"
  echo "  4. Set these fields:"
  echo
  print_line "Build command" "${build_command}"
  print_line "Deploy command" "${deploy_command}"
  print_line "Version command" "${version_command}"
  print_line "Root directory" "site"
  echo
  echo "These are the manual values to enter in Cloudflare's Build settings UI."
  echo "After saving those settings, rerun deploy/repair if needed."
  echo "============================================================"
  echo
}

print_line() {
  printf '%-24s %s\n' "$1" "$2"
}

colorize_status() {
  local status="$1"
  case "${status}" in
    PASS|yes|active)
      printf '%s%s%s\n' "${COLOR_GREEN}" "${status}" "${COLOR_RESET}"
      ;;
    FAIL|no|absent)
      printf '%s%s%s\n' "${COLOR_RED}" "${status}" "${COLOR_RESET}"
      ;;
    UNKNOWN|unknown)
      printf '%s%s%s\n' "${COLOR_YELLOW}" "${status}" "${COLOR_RESET}"
      ;;
    *)
      printf '%s\n' "${status}"
      ;;
  esac
}

print_check() {
  local rendered
  rendered="$(colorize_status "$1")"
  printf '  [%-16s] %s\n' "${rendered}" "$2"
}

status_yes_no() {
  if [ "$1" = "1" ]; then
    printf 'yes\n'
  else
    printf 'no\n'
  fi
}

check_mark() {
  local actual="$1"
  local expected="$2"

  if [ "${actual}" = "${expected}" ]; then
    printf 'PASS\n'
  else
    printf 'FAIL\n'
  fi
}

check_known() {
  local actual="$1"
  if [ -n "${actual}" ] && [ "${actual}" != "unknown" ] && [ "${actual}" != "absent" ]; then
    printf 'PASS\n'
  else
    printf 'UNKNOWN\n'
  fi
}

emit_status_summary() {
  local overall="PASS"
  local add_ready="PASS"
  local deploy_ready="PASS"
  local live_ready="PASS"

  if [ "${STATUS_SITE_PACKAGE_EXISTS}" != "1" ] || [ "${STATUS_SITE_LOCK_EXISTS}" != "1" ] || [ "${STATUS_SITE_ASTRO_BIN_EXISTS}" != "1" ]; then
    add_ready="FAIL"
    deploy_ready="FAIL"
    live_ready="FAIL"
  fi

  if [ "${STATUS_GITHUB_REPO_EXISTS}" != "1" ]; then
    add_ready="FAIL"
    deploy_ready="FAIL"
    live_ready="FAIL"
  fi

  if [ "${STATUS_ZONE_EXISTS}" != "1" ]; then
    add_ready="UNKNOWN"
    if [ "${deploy_ready}" = "PASS" ]; then deploy_ready="UNKNOWN"; fi
    if [ "${live_ready}" = "PASS" ]; then live_ready="UNKNOWN"; fi
  fi

  if [ "${STATUS_WORKER_SCRIPT_EXISTS}" != "1" ]; then
    live_ready="FAIL"
  fi

  if [ "${STATUS_WORKER_DOMAIN_COUNT}" -lt 2 ]; then
    live_ready="FAIL"
  fi

  if [ "${STATUS_EMAIL_RULE_COUNT}" -lt 2 ] || [ "${STATUS_CATCH_ALL_ENABLED}" != "yes" ]; then
    if [ "${add_ready}" = "PASS" ]; then add_ready="FAIL"; fi
  fi

  if [ "${live_ready}" = "FAIL" ] || [ "${deploy_ready}" = "FAIL" ] || [ "${add_ready}" = "FAIL" ]; then
    overall="FAIL"
  elif [ "${live_ready}" = "UNKNOWN" ] || [ "${deploy_ready}" = "UNKNOWN" ] || [ "${add_ready}" = "UNKNOWN" ]; then
    overall="UNKNOWN"
  fi

  echo "============================================================"
  printf '%sSTATUS SUMMARY:%s %s\n' "${COLOR_BOLD}${COLOR_BLUE}" "${COLOR_RESET}" "${STATUS_DOMAIN}"
  print_line "overall" "$(colorize_status "${overall}")"
  print_line "add baseline" "$(colorize_status "${add_ready}")"
  print_line "deploy ready" "$(colorize_status "${deploy_ready}")"
  print_line "live/bound" "$(colorize_status "${live_ready}")"
  echo "============================================================"
  echo
}

emit_status_checks() {
  printf '%s=== Checks ===%s\n' "${COLOR_BOLD}" "${COLOR_RESET}"
  print_check "$(check_mark "${STATUS_SITE_PACKAGE_EXISTS}" "1")" "site scaffold exists"
  print_check "$(check_mark "${STATUS_SITE_LOCK_EXISTS}" "1")" "lockfile exists"
  print_check "$(check_mark "${STATUS_SITE_ASTRO_BIN_EXISTS}" "1")" "dependencies installed"
  print_check "$(check_mark "${STATUS_GITHUB_REPO_EXISTS}" "1")" "GitHub repo exists"
  print_check "$(check_mark "${STATUS_ZONE_EXISTS}" "1")" "Cloudflare zone exists"
  print_check "$(check_mark "${STATUS_EMAIL_RULE_COUNT}" "2")" "email rules count is 2"
  print_check "$(check_mark "${STATUS_CATCH_ALL_ENABLED}" "yes")" "catch-all enabled"
  print_check "$(check_mark "${STATUS_WORKER_SCRIPT_EXISTS}" "1")" "worker deployed"
  if [ "${STATUS_WORKER_DOMAIN_COUNT}" -ge 2 ]; then
    print_check "PASS" "apex + www bound"
  else
    print_check "FAIL" "apex + www bound"
  fi
  echo
}

gather_status() {
  local domain="$1"
  STATUS_DOMAIN="${domain}"
  local worker_name="${domain//./-}"
  local submodule_path="sites/${domain}"
  local github_repo="bourneash/${domain}"

  STATUS_LOCAL_PATH_EXISTS=0
  STATUS_SUBMODULE_TRACKED=0
  STATUS_GIT_MODULE_EXISTS=0
  STATUS_SITE_PACKAGE_EXISTS=0
  STATUS_SITE_LOCK_EXISTS=0
  STATUS_SITE_NODE_MODULES_EXISTS=0
  STATUS_SITE_ASTRO_BIN_EXISTS=0
  STATUS_GITHUB_REPO_EXISTS=0
  STATUS_GITHUB_REPO_ARCHIVED="unknown"
  STATUS_GITHUB_ARCHIVED_VARIANTS=0
  STATUS_ZONE_EXISTS=0
  STATUS_ZONE_ID=""
  STATUS_ZONE_STATUS=""
  STATUS_WORKER_SCRIPT_EXISTS=0
  STATUS_WORKER_DOMAIN_COUNT=0
  STATUS_EMAIL_RULE_COUNT=0
  STATUS_CATCH_ALL_ENABLED="unknown"

  if [ -e "${DOMAINS_ROOT}/${submodule_path}" ]; then STATUS_LOCAL_PATH_EXISTS=1; fi
  if git ls-files --error-unmatch -- "${submodule_path}" >/dev/null 2>&1; then STATUS_SUBMODULE_TRACKED=1; fi
  if [ -d "${DOMAINS_ROOT}/.git/modules/${submodule_path}" ]; then STATUS_GIT_MODULE_EXISTS=1; fi
  if [ -f "${DOMAINS_ROOT}/${submodule_path}/site/package.json" ]; then STATUS_SITE_PACKAGE_EXISTS=1; fi
  if [ -f "${DOMAINS_ROOT}/${submodule_path}/site/package-lock.json" ]; then STATUS_SITE_LOCK_EXISTS=1; fi
  if [ -d "${DOMAINS_ROOT}/${submodule_path}/site/node_modules" ]; then STATUS_SITE_NODE_MODULES_EXISTS=1; fi
  if [ -x "${DOMAINS_ROOT}/${submodule_path}/site/node_modules/.bin/astro" ]; then STATUS_SITE_ASTRO_BIN_EXISTS=1; fi

  if gh repo view "${github_repo}" --json nameWithOwner,isArchived >/tmp/domain-manager-status-gh.json 2>/dev/null; then
    STATUS_GITHUB_REPO_EXISTS=1
    STATUS_GITHUB_REPO_ARCHIVED="$(python3 -c 'import json; print("yes" if json.load(open("/tmp/domain-manager-status-gh.json")).get("isArchived") else "no")')"
  fi
  rm -f /tmp/domain-manager-status-gh.json

  STATUS_GITHUB_ARCHIVED_VARIANTS="$(
    gh repo list bourneash --limit 200 --json name,isArchived 2>/dev/null | python3 -c '
import json, sys
prefix = sys.argv[1]
count = 0
for repo in json.load(sys.stdin):
    if repo.get("isArchived") and repo.get("name", "").startswith(prefix):
        count += 1
print(count)
' "${domain}-archived-"
  )"

  require_env

  local zone_json
  zone_json="$(curl -sS --max-time 30 "https://api.cloudflare.com/client/v4/zones?name=${domain}" -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")"
  STATUS_ZONE_ID="$(printf '%s' "${zone_json}" | python3 -c 'import json,sys; items=json.load(sys.stdin).get("result", []); print(items[0]["id"] if items else "")')"
  if [ -n "${STATUS_ZONE_ID}" ]; then
    STATUS_ZONE_EXISTS=1
    STATUS_ZONE_STATUS="$(printf '%s' "${zone_json}" | python3 -c 'import json,sys; items=json.load(sys.stdin).get("result", []); print(items[0].get("status","")) if items else print("")')"
  fi

  local tmp_worker_status
  tmp_worker_status="$(mktemp)"
  local worker_http
  worker_http="$(curl -sS --max-time 30 -o "${tmp_worker_status}" -w '%{http_code}' "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${worker_name}" -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")"
  if [ "${worker_http}" = "200" ] || [ "${worker_http}" = "204" ]; then STATUS_WORKER_SCRIPT_EXISTS=1; fi
  rm -f "${tmp_worker_status}"

  local domain_bindings_json
  domain_bindings_json="$(curl -sS --max-time 30 "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains?environment=production&hostname=${domain}" -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")"
  STATUS_WORKER_DOMAIN_COUNT="$(printf '%s' "${domain_bindings_json}" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("result", [])))')"
  local www_bindings_json
  www_bindings_json="$(curl -sS --max-time 30 "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains?environment=production&hostname=www.${domain}" -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")"
  STATUS_WORKER_DOMAIN_COUNT=$(( STATUS_WORKER_DOMAIN_COUNT + $(printf '%s' "${www_bindings_json}" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("result", [])))') ))

  if [ "${STATUS_ZONE_EXISTS}" = "1" ]; then
    local email_rules_json
    email_rules_json="$(curl -sS --max-time 30 "https://api.cloudflare.com/client/v4/zones/${STATUS_ZONE_ID}/email/routing/rules" -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")"
    STATUS_EMAIL_RULE_COUNT="$(printf '%s' "${email_rules_json}" | python3 -c '
import json, sys
domain = sys.argv[1]
count = 0
for rule in json.load(sys.stdin).get("result", []):
    for matcher in rule.get("matchers", []):
        if matcher.get("field") == "to" and matcher.get("value", "").endswith("@" + domain):
            count += 1
            break
print(count)
' "${domain}")"

    local catch_all_json
    catch_all_json="$(curl -sS --max-time 30 "https://api.cloudflare.com/client/v4/zones/${STATUS_ZONE_ID}/email/routing/rules/catch_all" -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")"
    STATUS_CATCH_ALL_ENABLED="$(printf '%s' "${catch_all_json}" | python3 -c 'import json,sys; data=json.load(sys.stdin); result=data.get("result") or {}; value=result.get("enabled"); print("yes" if value is True else "no" if value is False else "unknown")')"
  fi
}

cmd_status() {
  ensure_domain_arg "$@"
  local domain="$1"
  gather_status "${domain}"

  emit_status_summary

  echo
  printf '%s=== Domain status:%s %s\n' "${COLOR_BOLD}" "${COLOR_RESET}" "${domain}"
  print_line "local path" "$(colorize_status "$(status_yes_no "${STATUS_LOCAL_PATH_EXISTS}")")"
  print_line "submodule tracked" "$(colorize_status "$(status_yes_no "${STATUS_SUBMODULE_TRACKED}")")"
  print_line "git module state" "$(colorize_status "$(status_yes_no "${STATUS_GIT_MODULE_EXISTS}")")"
  print_line "site package.json" "$(colorize_status "$(status_yes_no "${STATUS_SITE_PACKAGE_EXISTS}")")"
  print_line "site package-lock.json" "$(colorize_status "$(status_yes_no "${STATUS_SITE_LOCK_EXISTS}")")"
  print_line "site node_modules" "$(colorize_status "$(status_yes_no "${STATUS_SITE_NODE_MODULES_EXISTS}")")"
  print_line "site astro binary" "$(colorize_status "$(status_yes_no "${STATUS_SITE_ASTRO_BIN_EXISTS}")")"
  print_line "github repo" "$(colorize_status "$(status_yes_no "${STATUS_GITHUB_REPO_EXISTS}")")"
  print_line "github archived" "$(colorize_status "${STATUS_GITHUB_REPO_ARCHIVED}")"
  print_line "archived repo variants" "${STATUS_GITHUB_ARCHIVED_VARIANTS}"
  print_line "cloudflare zone" "$(colorize_status "$(status_yes_no "${STATUS_ZONE_EXISTS}")")"
  print_line "zone id" "${STATUS_ZONE_ID:-absent}"
  print_line "zone status" "$(colorize_status "${STATUS_ZONE_STATUS:-absent}")"
  print_line "worker script" "$(colorize_status "$(status_yes_no "${STATUS_WORKER_SCRIPT_EXISTS}")")"
  print_line "worker domain binds" "${STATUS_WORKER_DOMAIN_COUNT}"
  print_line "email rules" "${STATUS_EMAIL_RULE_COUNT}"
  print_line "catch-all enabled" "$(colorize_status "${STATUS_CATCH_ALL_ENABLED}")"
  echo
  emit_status_checks
}

cmd_repair() {
  ensure_domain_arg "$@"
  local domain="$1"
  shift

  local plan_only=0
  local allow_email=1
  local allow_deploy=1
  local allow_bind=1

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --plan) plan_only=1 ;;
      --no-email) allow_email=0 ;;
      --no-deploy) allow_deploy=0 ;;
      --no-bind) allow_bind=0 ;;
      *)
        echo "ERROR: unknown repair flag: $1" >&2
        usage
        exit 1
        ;;
    esac
    shift
  done

  local loop_count=0
  local max_loops=6

  while true; do
    gather_status "${domain}"

    if [ "${STATUS_GITHUB_REPO_EXISTS}" = "1" ]; then
      emit_cf_build_setup_notice "${domain}"
    fi

    local actions=()
    if [ "${STATUS_SITE_PACKAGE_EXISTS}" = "1" ] && { [ "${STATUS_SITE_NODE_MODULES_EXISTS}" = "0" ] || [ "${STATUS_SITE_ASTRO_BIN_EXISTS}" = "0" ]; }; then
      actions+=("install")
    fi
    if [ "${allow_email}" = "1" ] && [ "${STATUS_ZONE_EXISTS}" = "1" ] && { [ "${STATUS_EMAIL_RULE_COUNT}" -lt 2 ] || [ "${STATUS_CATCH_ALL_ENABLED}" != "yes" ]; }; then
      actions+=("email")
    fi
    if [ "${allow_deploy}" = "1" ] && [ "${STATUS_SITE_PACKAGE_EXISTS}" = "1" ] && [ "${STATUS_WORKER_SCRIPT_EXISTS}" = "0" ]; then
      actions+=("deploy")
    fi
    if [ "${allow_bind}" = "1" ] && [ "${STATUS_WORKER_SCRIPT_EXISTS}" = "1" ] && [ "${STATUS_WORKER_DOMAIN_COUNT}" -lt 2 ]; then
      actions+=("bind")
    fi

    echo
    printf '%s=== Repair plan:%s %s\n' "${COLOR_BOLD}" "${COLOR_RESET}" "${domain}"
    if [ "${#actions[@]}" -eq 0 ]; then
      printf 'RESULT: %s\n' "$(colorize_status "PASS")"
      echo "No automatic repair actions needed."
      echo
      emit_status_summary
      emit_status_checks
      return 0
    fi

    printf 'RESULT: %s\n' "$(colorize_status "FAIL")"
    local action
    for action in "${actions[@]}"; do
      case "${action}" in
        install) echo " - install site dependencies" ;;
        email) echo " - configure email routing" ;;
        deploy) echo " - deploy worker" ;;
        bind) echo " - bind custom domains" ;;
      esac
    done
    echo

    if [ "${plan_only}" = "1" ]; then
      return 0
    fi

    action="${actions[0]}"
    printf '%s--- Running repair step:%s %s\n' "${COLOR_BOLD}" "${COLOR_RESET}" "${action}"
    case "${action}" in
      install) run_site_install "${domain}" ;;
      email) run_email "${domain}" ;;
      deploy) run_deploy "${domain}" ;;
      bind) run_bind "${domain}" ;;
    esac

    loop_count=$((loop_count + 1))
    if [ "${loop_count}" -ge "${max_loops}" ]; then
      echo
      printf 'RESULT: %s\n' "$(colorize_status "UNKNOWN")"
      echo "Stopped after ${max_loops} repair iterations."
      echo
      return 1
    fi
  done
}

cmd_add() {
  local mode="managed"
  local do_deploy=1
  local do_bind=1
  local bootstrap_only=0
  local pass_flags=()

  ensure_domain_arg "$@"
  local domain="$1"
  shift

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --full) mode="full" ;;
      --bootstrap-only) bootstrap_only=1 ;;
      --no-deploy) do_deploy=0 ;;
      --no-bind) do_bind=0 ;;
      --no-email) pass_flags+=("$1") ;;
      *)
        echo "ERROR: unknown add flag: $1" >&2
        usage
        exit 1
        ;;
    esac
    shift
  done

  if [ "${mode}" = "full" ]; then
    run_add_full "${domain}" "${pass_flags[@]}"
    return 0
  fi

  if run_bootstrap "${domain}" "${pass_flags[@]}"; then
    :
  else
    local bootstrap_status=$?
    if [ "${bootstrap_status}" = "2" ]; then
      echo
      printf '%sNOTICE:%s partial setup detected for %s\n' "${COLOR_BOLD}${COLOR_YELLOW}" "${COLOR_RESET}" "${domain}"
      echo "Switching to repair flow instead of failing add."
      echo
      local repair_flags=()
      if printf '%s\n' "${pass_flags[@]:-}" | grep -qx -- '--no-email'; then
        repair_flags+=(--no-email)
      fi
      cmd_repair "${domain}" --plan "${repair_flags[@]}"
      if [ "${bootstrap_only}" = "1" ] || [ "${do_deploy}" = "0" ]; then
        return 0
      fi
      if [ "${do_bind}" = "0" ]; then
        repair_flags+=(--no-bind)
      fi
      cmd_repair "${domain}" "${repair_flags[@]}"
      return 0
    fi
    return "${bootstrap_status}"
  fi

  emit_cf_build_setup_notice "${domain}"

  if [ "${bootstrap_only}" = "1" ] || [ "${do_deploy}" = "0" ]; then
    return 0
  fi

  run_deploy "${domain}"

  if [ "${do_bind}" = "1" ]; then
    run_bind "${domain}"
  fi
}

cmd_remove() {
  ensure_domain_arg "$@"
  local domain="$1"
  shift
  run_remove "${domain}" "$@"
}

prompt_domain() {
  local domain
  read -r -p "Domain: " domain
  if [ -z "${domain}" ]; then
    echo "No domain entered."
    return 1
  fi
  printf '%s\n' "${domain}"
}

prompt_yes_no() {
  local prompt="$1"
  local reply
  read -r -p "${prompt} [y/N]: " reply
  case "${reply}" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

interactive_add() {
  local domain
  domain="$(prompt_domain)" || return 0

  if prompt_yes_no "Run one-shot full add (bootstrap + deploy + bind)?"; then
    local flags=()
    if prompt_yes_no "Skip email routing setup during bootstrap?"; then
      flags+=(--no-email)
    fi
    cmd_add "${domain}" --full "${flags[@]}"
    return 0
  fi

  local flags=()
  if prompt_yes_no "Skip email routing setup during bootstrap?"; then
    flags+=(--no-email)
  fi
  if prompt_yes_no "Stop after bootstrap only?"; then
    cmd_add "${domain}" --bootstrap-only "${flags[@]}"
    return 0
  fi
  if prompt_yes_no "Skip bind step after deploy?"; then
    cmd_add "${domain}" --no-bind "${flags[@]}"
    return 0
  fi

  cmd_add "${domain}" "${flags[@]}"
}

interactive_remove() {
  local domain
  domain="$(prompt_domain)" || return 0

  local flags=()
  if prompt_yes_no "Delete the GitHub repo instead of renaming + archiving it?"; then
    flags+=(--delete-repo)
  fi
  if prompt_yes_no "Skip GitHub cleanup?"; then
    flags+=(--no-github)
  fi
  if prompt_yes_no "Skip Cloudflare cleanup?"; then
    flags+=(--no-cloudflare)
  fi
  if prompt_yes_no "Skip local repo cleanup?"; then
    flags+=(--no-local)
  fi

  run_remove "${domain}" "${flags[@]}"
}

interactive_menu() {
  while true; do
    cat <<'EOF'

Domain Manager
  1) Add domain (bootstrap -> deploy -> bind)
  2) Add domain (bootstrap only)
  3) Add domain (full one-shot path)
  4) Remove domain
  5) Status
  6) Repair
  7) Deploy existing domain
  8) Bind existing domain
  9) Configure email routing
 10) Bootstrap only
 11) Quit
EOF

    local choice
    read -r -p "Choose an action [1-11]: " choice

    case "${choice}" in
      1) interactive_add ;;
      2)
        local domain
        domain="$(prompt_domain)" || continue
        cmd_add "${domain}" --bootstrap-only
        ;;
      3)
        local domain
        domain="$(prompt_domain)" || continue
        cmd_add "${domain}" --full
        ;;
      4) interactive_remove ;;
      5)
        local domain
        domain="$(prompt_domain)" || continue
        cmd_status "${domain}"
        ;;
      6)
        local domain
        domain="$(prompt_domain)" || continue
        if prompt_yes_no "Plan only?"; then
          cmd_repair "${domain}" --plan
        else
          cmd_repair "${domain}"
        fi
        ;;
      7)
        local domain
        domain="$(prompt_domain)" || continue
        run_deploy "${domain}"
        ;;
      8)
        local domain
        domain="$(prompt_domain)" || continue
        run_bind "${domain}"
        ;;
      9)
        local domain
        domain="$(prompt_domain)" || continue
        run_email "${domain}"
        ;;
      10)
        local domain
        domain="$(prompt_domain)" || continue
        run_bootstrap "${domain}"
        ;;
      11) return 0 ;;
      *) echo "Invalid choice." ;;
    esac
  done
}

main() {
  local cmd="${1:-menu}"

  case "${cmd}" in
    menu)
      interactive_menu
      ;;
    add)
      shift
      cmd_add "$@"
      ;;
    remove)
      shift
      cmd_remove "$@"
      ;;
    status)
      shift
      cmd_status "$@"
      ;;
    repair)
      shift
      cmd_repair "$@"
      ;;
    deploy)
      shift
      ensure_domain_arg "$@"
      run_deploy "$1"
      ;;
    bind)
      shift
      ensure_domain_arg "$@"
      run_bind "$1"
      ;;
    email)
      shift
      ensure_domain_arg "$@"
      run_email "$1"
      ;;
    bootstrap)
      shift
      ensure_domain_arg "$@"
      run_bootstrap "$1" "${@:2}"
      ;;
    help|--help|-h)
      usage
      ;;
    *)
      echo "ERROR: unknown command: ${cmd}" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
