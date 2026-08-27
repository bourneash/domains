#!/usr/bin/env bash
# collect-seo-facts.sh — one-shot mechanical survey for the seo-analyst role.
#
# Replaces ~10-15 turns of ls/grep/wc exploration with a single tool call.
# Pure fact-gathering, zero judgment — the agent still decides what's worth
# flagging and filing as a task. Run from the site repo root (cwd containing
# `site/`). Safe to re-run; read-only.
set -uo pipefail
cd "$(dirname "$0")/../.." 2>/dev/null || true
SITE_DIR="site"
[[ -d "$SITE_DIR/src" ]] || SITE_DIR="."

echo "## dist"
[[ -d "$SITE_DIR/dist" ]] && echo "dist/ exists" || echo "dist/ MISSING — run npm run build"

echo
echo "## JSON-LD emitters"
grep -rl "application/ld+json" "$SITE_DIR/src" --include="*.astro" 2>/dev/null || echo "none found"

echo
echo "## RSS feed"
if grep -rlq "rss\|RSS" "$SITE_DIR/src/layouts" --include="*.astro" 2>/dev/null; then
  echo "referenced in a layout"
else
  find "$SITE_DIR/src/pages" -iname "*rss*" 2>/dev/null | grep -q . && echo "rss page file exists" || echo "no RSS feed found"
fi

echo
echo "## IndexNow script"
find "$SITE_DIR" -iname "*indexnow*" -not -path "*/node_modules/*" -not -path "*/dist/*" 2>/dev/null | grep -q . \
  && find "$SITE_DIR" -iname "*indexnow*" -not -path "*/node_modules/*" -not -path "*/dist/*" 2>/dev/null \
  || echo "no IndexNow script found"

echo
echo "## Content collections — page count, word-count range, thin pages (<300w), FAQ coverage"
if [[ -d "$SITE_DIR/src/content" ]]; then
  for coll in "$SITE_DIR/src/content"/*/; do
    [[ -d "$coll" ]] || continue
    name=$(basename "$coll")
    files=("$coll"*.md "$coll"*.mdx)
    n=0; thin=0; faq=0
    for f in "${files[@]}"; do
      [[ -f "$f" ]] || continue
      n=$((n+1))
      w=$(wc -w < "$f" 2>/dev/null || echo 0)
      [[ "$w" -lt 300 ]] && { thin=$((thin+1)); echo "  THIN: $f ($w words)"; }
      grep -q "^faq:" "$f" 2>/dev/null && faq=$((faq+1))
    done
    [[ "$n" -eq 0 ]] && continue
    echo "$name: $n pages, $faq with FAQ, $thin under 300 words"
  done
else
  echo "no src/content/ collections"
fi

echo
echo "## Outbound internal-link counts per content-driven page template"
find "$SITE_DIR/src/pages" -name "\[...slug\].astro" 2>/dev/null | sort -u | while read -r f; do
  count=$(grep -o 'href="/[^"]*"' "$f" | wc -l)
  echo "  $f: $count static internal hrefs in template (per-page links inside content body not counted here)"
done

echo
echo "## Page routes with zero inbound links from other pages (rough orphan check)"
for page in "$SITE_DIR"/src/pages/*.astro; do
  [[ -f "$page" ]] || continue
  base=$(basename "$page" .astro)
  [[ "$base" == "index" || "$base" == "404" ]] && continue
  hits=$(grep -rl "href=\"/${base}" "$SITE_DIR/src" --include="*.astro" 2>/dev/null | grep -v "/${base}\.astro$" | wc -l)
  [[ "$hits" -eq 0 ]] && echo "  possible orphan: /$base (no inbound href found in src/)"
done

echo
echo "## Done. Interpretation and task-filing is the agent's job from here."
