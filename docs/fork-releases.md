# Manual owner-fork releases

This process uses only `phroggingphrog/pi-pocket`. It never publishes to `TannerMidd/pi-pocket` or npm. The release workflow starts only when an owner runs it from GitHub Actions. It does not run on a push or schedule. It does not install a release or restart a service.

## Prepare a release revision

Fetch the owner fork. Inspect the commit graph, tags, and custom commits before release. Do not discard local changes or overwrite custom commits.

```bash
git clone https://github.com/phroggingphrog/pi-pocket.git
cd pi-pocket
git fetch origin --tags --prune
git log --graph --decorate --oneline -20 origin/main
git tag --list 'v*' --sort=-version:refname
```

Select an already verified commit that is an ancestor of owner-fork `main`. Pick a new version. The package version must match the new tag. Use a branch for release metadata. Keep the current commits intact.

```bash
git switch -c release/v0.28.0 <verified-commit>
npm version 0.28.0 --no-git-tag-version
npm install --package-lock-only --ignore-scripts
npm ci
npm run check
npm run lint
npm test
```

Review the package version and lock file. Commit the release metadata. Merge this release-preparation branch through the owner's normal review process. Do not force-push or move an existing tag.

## Run the manual release workflow

Open the owner fork in GitHub. Choose **Actions → Manual fork release → Run workflow**. Enter the new tag, the exact 40-character revision SHA, and `publish` in the confirmation field.

The workflow checks the owner repository, the commit, its ancestry from owner-fork `main`, the package version, the clean checkout, and the unused tag. It installs locked dependencies and runs checks, lint, and tests. It creates a source archive and an npm tarball. It calculates SHA256 checksums and writes a manifest with the repository, tag, commit, version, asset names, sizes, and hashes. It verifies the hashes before it creates a release in the owner fork.

This workflow is manual only. It does not modify the default branch. It does not push a branch or merge a PR. It does not publish to npm. It does not change the live updater source or restart any service. GitHub creates the release tag at the exact requested revision.

## Fetch and verify release artifacts

Download the release assets from `https://github.com/phroggingphrog/pi-pocket/releases`. Keep the download in a new directory. Verify SHA256 values before use.

```bash
sha256sum --check SHA256SUMS
python3 -m json.tool release-manifest.json
```

Check that the manifest names `phroggingphrog/pi-pocket`. Check that its tag, version, commit, asset sizes, and SHA256 values match the release page and files. Check the archive contents without extracting them to the live checkout.

```bash
tar -tzf pi-pocket-v0.28.0-source.tar.gz | head
mkdir -p inspect-npm && tar -xzf pi-pocket-v0.28.0.tgz -C inspect-npm
node -p "require('./inspect-npm/package/package.json').version"
```

The printed package version must match the tag. Keep the manifest and checksum output with the release record.

## Manual installation and rollback

Release publication does not deploy. It does not restart a service. The standard in-app updater still uses its existing configured source. This PR does not change that source. Do not select the owner fork in the live updater until a separate owner-authorized activation change exists.

For a separate checkout, first preserve changes and commits. Back up its data before installation. A clean worktree is required. Do not reset a shared branch.

```bash
git status --short
git branch backup/before-v0.28.0 HEAD
git fetch https://github.com/phroggingphrog/pi-pocket.git refs/tags/v0.28.0:refs/tags/v0.28.0
git show --no-patch --format=fuller v0.28.0
git diff --quiet && git diff --cached --quiet
npm ci
```

Only after all checks and backups, install the exact verified tag in that separate checkout. Do not start or restart a live service as part of release publication.

```bash
git switch --detach v0.28.0
npm ci
npm run check
npm run lint
npm test
```

To roll back that separate checkout, restore its recorded prior verified commit and its locked packages. Preserve the release tag, custom commits, local changes, and data backup. Do not reset a shared branch.

```bash
git switch --detach <previous-verified-commit>
npm ci
npm run check
npm test
```

## Live activation is a separate owner action

The earlier deployment authorization still applies only after a verified fork release and integration checks. This work does not change the live updater's repository or restart the live service. A live operator must separately authorize any updater-source change, back up live configuration, verify the release URL, revision, artifact hashes, current database state, and rollback plan, then use the approved service procedure. Foreman stays disabled. Do not choose a model, add credentials, or send assessment data as part of release work.
