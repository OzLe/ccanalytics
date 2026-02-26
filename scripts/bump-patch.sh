#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Read current version from package.json
CURRENT=$(node -p "require('$REPO_ROOT/package.json').version")

# Split into major.minor.patch and increment patch
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
NEW_PATCH=$((PATCH + 1))
NEW_VERSION="${MAJOR}.${MINOR}.${NEW_PATCH}"

echo "Bumping version: $CURRENT -> $NEW_VERSION"

# Update package.json files
node -e "
const fs = require('fs');
for (const p of ['$REPO_ROOT/package.json', '$REPO_ROOT/dashboard/package.json']) {
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
}
"

# Regenerate version.ts
bash "$REPO_ROOT/scripts/update-version.sh"

# Stage changes and amend the merge commit
git -C "$REPO_ROOT" add package.json dashboard/package.json src/version.ts
git -C "$REPO_ROOT" commit --amend --no-edit
