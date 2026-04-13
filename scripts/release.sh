#!/bin/bash
# Release homebridge-clearlight-sauna to GitHub + npm
# Run from anywhere -- resolves paths from script location.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_REPO="$HOME/Documents/homebridge-clearlight-sauna"
REMOTE="https://github.com/Mustavo/homebridge-clearlight-sauna.git"

# Files to sync (excludes dev-only files like .env, node_modules, dist, *.tgz)
SYNC_FILES=(README.md CHANGELOG.md LICENSE package.json package-lock.json config.schema.json tsconfig.json .gitignore .npmignore)
SYNC_DIRS=(src images)

echo "=== homebridge-clearlight-sauna release ==="

# Clone or update the distribution repo
if [ ! -d "$DIST_REPO/.git" ]; then
  echo "Cloning distribution repo..."
  git clone "$REMOTE" "$DIST_REPO"
else
  echo "Updating distribution repo..."
  git -C "$DIST_REPO" pull --ff-only
fi

# Sync files
echo "Syncing files from Claudia monorepo..."
for f in "${SYNC_FILES[@]}"; do
  if [ -f "$PLUGIN_DIR/$f" ]; then
    cp "$PLUGIN_DIR/$f" "$DIST_REPO/$f"
  fi
done
for d in "${SYNC_DIRS[@]}"; do
  if [ -d "$PLUGIN_DIR/$d" ]; then
    rm -rf "$DIST_REPO/$d"
    cp -r "$PLUGIN_DIR/$d" "$DIST_REPO/$d"
  fi
done

# Build
echo "Building TypeScript..."
cd "$DIST_REPO"
npm install --ignore-scripts
npm run build

# Show what changed
echo ""
echo "=== Changes ==="
git status --short
echo ""

# Confirm before pushing
read -p "Commit, push, and publish to npm? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted. Changes are staged in $DIST_REPO"
  exit 0
fi

# Get version for commit message
VERSION=$(node -p "require('./package.json').version")

# Commit and push
git add -A
git commit -m "v${VERSION}"
git tag -a "v${VERSION}" -m "v${VERSION}" 2>/dev/null || echo "Tag v${VERSION} already exists, skipping"
git push
git push --tags 2>/dev/null || true

# Publish to npm
npm publish

echo ""
echo "=== Released v${VERSION} ==="
echo "  npm: https://www.npmjs.com/package/homebridge-clearlight-sauna"
echo "  git: https://github.com/Mustavo/homebridge-clearlight-sauna"
