#!/usr/bin/env bash
# Fleet-wide capability policy for content-writer transactions.
# Source this file, then call:
#   content_writer_path_allowed <relative-path> <selected-task>

content_writer_task_capabilities() {
  case "${1:-}" in
    ops/tasks/in-progress/remaining-hero-images.md)
      printf '%s\n' content hero-prompts generated-images
      ;;
    *)
      printf '%s\n' content
      ;;
  esac
}

content_writer_has_capability() {
  local capability="$1" task="$2"
  content_writer_task_capabilities "$task" | grep -Fxq "$capability"
}

content_writer_path_allowed() {
  local path="${1:-}" selected_task="${2:-}"
  case "$path" in
    site/src/content/*|site/src/pages/*|site/src/components/*|site/src/layouts/*|site/src/assets/*|site/public/images/generated/*|site/src/lib/affiliate.ts)
      return 0
      ;;
    ops/prompts/hero/prompts.txt)
      content_writer_has_capability hero-prompts "$selected_task"
      ;;
    *)
      return 1
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  content_writer_path_allowed "${1:-}" "${2:-}"
fi
