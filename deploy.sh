#!/usr/bin/env bash
# Publish the built app to the gh-pages branch.
#
# This is a branch deploy rather than a GitHub Actions workflow because the
# local gh token lacks the `workflow` scope and cannot push workflow files.
# To switch to automatic deploys on every push instead, run:
#
#     gh auth refresh -s workflow
#
# then ask Claude to restore the Actions workflow.
set -euo pipefail
cd "$(dirname "$0")"

echo "Building with the Pages base path..."
GITHUB_PAGES=true npm run build

WORKTREE=".gh-pages-build"
rm -rf "$WORKTREE"
git worktree prune

if git show-ref --quiet refs/remotes/origin/gh-pages; then
  git worktree add "$WORKTREE" -B gh-pages origin/gh-pages
else
  git worktree add --detach "$WORKTREE"
  git -C "$WORKTREE" checkout --orphan gh-pages
  git -C "$WORKTREE" rm -rf . >/dev/null 2>&1 || true
fi

# Clear the old build but keep git's own directory file
find "$WORKTREE" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
cp -R dist/. "$WORKTREE"/
# Stop GitHub running the output through Jekyll, which would drop _-prefixed files
touch "$WORKTREE/.nojekyll"

git -C "$WORKTREE" add -A
if git -C "$WORKTREE" diff --cached --quiet; then
  echo "No changes to publish."
else
  git -C "$WORKTREE" commit -q -m "deploy: $(git rev-parse --short HEAD)"
  git -C "$WORKTREE" push -q origin gh-pages
  echo "Published."
fi

git worktree remove --force "$WORKTREE"
echo "Live at https://cfarnz.github.io/route-builder/"
