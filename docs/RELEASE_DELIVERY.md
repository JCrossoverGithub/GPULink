# Release delivery (DEV-05B)

The first distribution channel is GitHub Releases. The `CLI preview candidate`
workflow now has a read-only `release-delivery` job on `main` (push or manual
workflow dispatch), dependent on both installed-package acceptance jobs. It
archives their existing candidate bytes, not a second build. PR runs do not
stage delivery. This job uploads an Actions artifact only; it does not create a
GitHub Release, tag, publish a package, or grant compute access.

## Maintainer: obtain accepted-main assets

Use a successful main run of the distribution workflow, not a PR merge revision.
Also require successful ordinary CI for the same exact main revision, and review
its acceptance record and release notes. The examples below use Bash and an
authenticated GitHub CLI in the repository. Substitute the reviewed run IDs
and full accepted main SHA; do not use the latest artifact implicitly.

```sh
REV="REPLACE_WITH_REVIEWED_MAIN_SHA"
DIST_RUN="REPLACE_WITH_DISTRIBUTION_RUN_ID"
CI_RUN="REPLACE_WITH_CI_RUN_ID"
for RUN in "$DIST_RUN" "$CI_RUN"; do
  gh run view "$RUN" --json workflowName,headBranch,headSha,event,status,conclusion
  test "$(gh run view "$RUN" --json headBranch --jq .headBranch)" = main || exit 1
  test "$(gh run view "$RUN" --json headSha --jq .headSha)" = "$REV" || exit 1
  test "$(gh run view "$RUN" --json conclusion --jq .conclusion)" = success || exit 1
done
test "$(gh run view "$DIST_RUN" --json workflowName --jq .workflowName)" = 'CLI preview candidate' || exit 1
test "$(gh run view "$CI_RUN" --json workflowName --jq .workflowName)" = CI || exit 1
```

Check the displayed events are push or workflow_dispatch, not pull_request.
The distribution run must include a successful `release-delivery` job. Use a
fresh download directory outside the repository:

```sh
DELIVERY=$(mktemp -d)
gh run download "$DIST_RUN" --name "gpulink-release-delivery-$REV" --dir "$DELIVERY"
cd "$DELIVERY"
sha256sum -c -- *.zip.sha256
```

The two assets are `gpulink-distribution-v<version>-<full-revision>.zip` and
its `.zip.sha256` companion. They are intended for delivery together. The
archive contains the unchanged candidate directory contents, including the
inner `candidate.json` and `SHA256SUMS`. It does not contain credentials,
configuration, databases, models, or GPU drivers. The manifest still says
`candidate-not-published` because the packages are not registry publications.

## Maintainer: explicit draft release only

When separately authorized, choose an unused release tag such as
`gpulink-v0.1.0-preview.1`. The tag is a release identifier, not a claim that the
internal npm package versions have changed. Confirm the tag and release do not
already exist, and that the target commit is the accepted main revision. From
the checked and verified assets directory, an authorized maintainer may create a
**draft prerelease**, targeting that exact SHA:

```sh
TAG=gpulink-v0.1.0-preview.1  # example only; select an unused tag
# Review both commands' results; a network/auth error is not proof of absence.
gh release view "$TAG" --repo JCrossoverGithub/GPULink
git ls-remote --tags https://github.com/JCrossoverGithub/GPULink.git "refs/tags/$TAG"
# Only after confirming absence and receiving explicit draft authorization:
gh release create "$TAG" --repo JCrossoverGithub/GPULink \
  --target "$REV" --draft --prerelease \
  --title "GPULink $TAG" \
  --notes "Preview from $REV. See installation and limitations: https://github.com/JCrossoverGithub/GPULink/blob/$REV/docs/RELEASE_DELIVERY.md. Not a public GPU service." \
  ./*.zip ./*.zip.sha256
```

Review the draft target, exact assets, checksums, platform prerequisites and
known limitations before separately authorizing publication in GitHub. Never
replace an existing release asset or reuse a released tag for different bytes.
No script in DEV-05B performs these write operations automatically. Public
visibility depends on repository visibility; draft access depends on permissions.

## Consumer: install without a source checkout

Once a release is explicitly published, download both assets from its trusted
GitHub release page. For internal testing use the reviewed Actions artifact
instead. Verify the outer archive digest against its companion from the trusted
source before extraction (`sha256sum -c -- *.zip.sha256` on Linux/WSL;
`Get-FileHash -Algorithm SHA256 -LiteralPath <zip>` on Windows, compare with
its companion). Extract into a new directory, check `candidate.json` against the
expected revision, and verify the inner checksums. Follow the [distribution
installation guide](DISTRIBUTION_CANDIDATE.md) to install only the package you
need. Windows supports CLI configuration and diagnostics; managed services are
Linux/WSL only. Node 24+, npm and .NET 10 prerequisites are unchanged. The
published NuGet preview is distinct from local candidate bytes of the same
version. Use a separate package cache for local candidate testing.

## Updates and registry readiness

There is no automatic upgrade or database migration/rollback guarantee yet.
Use a separate user-owned CLI prefix and separate test configuration for a new
candidate; do not overwrite a running installation. Before a deliberate update,
finish or cancel work safely, drain/stop workers and stop the owned control
plane, confirm shutdown, and back up the complete private installation directory
(including SQLite and credentials) securely. Retain the old package and backup.
Do not point a new version at production data until compatibility and restore
have been validated; never run two control planes on the same database. Keep
client dependency versions pinned and update the application independently.

Registry publication is not part of this increment. Confirm npm scope ownership,
package identity and publishing rights with the registry before changing private
flags or choosing public versions; a missing registry search result is not proof
of ownership. Confirm NuGet version availability and publisher authorization
before using the existing separately authorized NuGet workflow. Do not reuse a
published version for different bytes. Checksums and source revision metadata
are not signed provenance or independently authenticated attestations.
