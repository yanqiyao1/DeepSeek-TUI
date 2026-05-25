#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./update.sh [patch|minor|major] "release notes"

Environment:
  SEEKCODE_RELEASE_DRY_RUN=1    print commands without publishing, committing, tagging, or pushing
  SEEKCODE_RELEASE_PUBLISH=1    allow npm publish (requires NPM_TOKEN or npm login)
  NPM_TOKEN                     optional npm token; never store it in this file

The script always runs typecheck/build/tests before release actions and commits the current batch.
USAGE
}

BUMP_TYPE="${1:-patch}"
RELEASE_NOTES="${2:-}"
DRY_RUN="${SEEKCODE_RELEASE_DRY_RUN:-0}"
ALLOW_PUBLISH="${SEEKCODE_RELEASE_PUBLISH:-0}"

if [[ "$BUMP_TYPE" != "patch" && "$BUMP_TYPE" != "minor" && "$BUMP_TYPE" != "major" ]]; then
  usage >&2
  echo "Invalid bump type: $BUMP_TYPE" >&2
  exit 2
fi

if [[ -z "$RELEASE_NOTES" ]]; then
  usage >&2
  echo "Release notes are required." >&2
  exit 2
fi

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+ %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

preflight_publish_credentials() {
  if [[ "$DRY_RUN" == "1" ]]; then
    return
  fi
  if [[ "$ALLOW_PUBLISH" == "1" ]]; then
    if [[ -n "${NPM_TOKEN:-}" ]]; then
      npm whoami --//registry.npmjs.org/:_authToken="$NPM_TOKEN" >/dev/null
    else
      npm whoami >/dev/null
    fi
  fi
  gh auth status >/dev/null
  git ls-remote origin HEAD >/dev/null
}

current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "main" ]]; then
  echo "Release must run from main; current branch is '$current_branch'." >&2
  exit 1
fi

if git status --porcelain | grep -E '^(UU|AA|DD|AU|UA|DU|UD) ' >/dev/null; then
  echo "Release cannot continue with unresolved merge conflicts." >&2
  exit 1
fi

npm test

next_version="$(node -e 'const pkg=require("./package.json"); const [major,minor,patch]=pkg.version.split(".").map(Number); const bump=process.argv[1]; const version=bump==="major"?`${major+1}.0.0`:bump==="minor"?`${major}.${minor+1}.0`:`${major}.${minor}.${patch+1}`; console.log(version)' "$BUMP_TYPE")"

tag="v$next_version"
commit_message="release: $tag - $RELEASE_NOTES"

if git rev-parse "$tag" >/dev/null 2>&1; then
  echo "Tag already exists locally: $tag" >&2
  exit 1
fi

if git ls-remote --exit-code --tags origin "$tag" >/dev/null 2>&1; then
  echo "Tag already exists on origin: $tag" >&2
  exit 1
fi

preflight_publish_credentials

if [[ "$DRY_RUN" != "1" ]]; then
  bumped_version="$(npm version "$BUMP_TYPE" --no-git-tag-version)"
  bumped_version="${bumped_version#v}"
  if [[ "$bumped_version" != "$next_version" ]]; then
    echo "Computed version $next_version but npm produced $bumped_version." >&2
    exit 1
  fi
fi

if [[ "$ALLOW_PUBLISH" == "1" ]]; then
  if [[ -n "${NPM_TOKEN:-}" ]]; then
    run npm publish --access public --//registry.npmjs.org/:_authToken="$NPM_TOKEN"
  else
    run npm publish --access public
  fi
else
  echo "Skipping npm publish. Set SEEKCODE_RELEASE_PUBLISH=1 to publish."
fi

run git add .
run git commit -m "$commit_message"
run git tag -a "$tag" -m "$commit_message"
run git push origin main
run git push origin "$tag"
run gh release create "$tag" --title "$tag" --notes "$RELEASE_NOTES"
