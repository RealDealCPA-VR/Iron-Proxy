# Releasing

Two things get released, separately:

- **The npm packages** `@iron-proxy/core`, `@iron-proxy/proxy`, `@iron-proxy/electron`, `@iron-proxy/react` and `iron-proxy` (the CLI), through changesets.
- **The tray app installers** (`apps/tray`, private on npm) for Windows, macOS and Linux, through a `tray-v<version>` tag, then by hand to winget and Homebrew.

Every step below is a manual maintainer step. **Nothing has been published yet**: not to npm, not to GitHub Releases, not to winget, not to Homebrew. The README's install commands for those channels say "after the first … release" until the steps here are done once.

## npm packages

### What is already in place

- Each publishable package ships `README.md` and `LICENSE` in its tarball, has `publishConfig: { access: "public", provenance: true }`, `repository` / `homepage` / `bugs`, and `exports` whose `import` and `require` branches each name their own types (`.d.ts` and `.d.cts`).
- `pnpm pack:check` (part of `pnpm check`, and the `pack` job in CI) runs `npm pack --dry-run --json` for each package and fails when a file named by `exports` / `main` / `types` / `bin`, `README.md` or `LICENSE` is missing from the tarball, or when `src/` or `test/` would be published.
- `.github/workflows/release.yml` runs on every push to `main`: with pending changesets it opens (or updates) a **"chore: version packages"** pull request; once that pull request is merged it runs `pnpm release` (`pnpm build && changeset publish`), which publishes the bumped packages with npm provenance.

### One-time setup

1. **Own the scope.** Create the npm organisation `iron-proxy` (npmjs.com → Add Organization, free for public packages) so `@iron-proxy/*` can be published, and check that the unscoped name `iron-proxy` (the CLI) is still free. If the scope cannot be had, rename every `@iron-proxy/*` package (package.json `name`, the workspace dependencies, imports in examples and docs, `.changeset/config.json`) to a scope you own before the first publish.
2. **Add the token.** Create an npm **automation** access token (or a granular token with publish rights on the scope and the `iron-proxy` package) and add it to the GitHub repository as the secret `NPM_TOKEN` (Settings → Secrets and variables → Actions).
3. **Provenance** needs the repository to be public and the publish to run in GitHub Actions with `id-token: write` (the release workflow already has it). A local `npm publish` of these packages fails on purpose because `provenance: true` is set; publish from CI.

### Each release

1. Every user-visible change lands with a changeset (`pnpm changeset`).
2. On `main`, the release workflow keeps a **"chore: version packages"** pull request up to date. Review the versions and changelogs in it.
3. **Merge it.** The workflow then builds and publishes. Nothing reaches npm before this merge.
4. Check the packages on npmjs.com (the provenance badge shows the workflow run) and try `npx iron-proxy@latest doctor`.

## Tray app installers

### What the workflow does

`.github/workflows/tray-release.yml` runs on a pushed tag `tray-v<version>` (and by hand from the Actions tab):

- builds on `windows-latest`, `macos-latest` and `ubuntu-latest` with electron-builder (`apps/tray/electron-builder.yml`):
  - Windows: `Iron-Proxy-Setup-<version>-x64.exe` and `Iron-Proxy-Setup-<version>-arm64.exe` (NSIS, per-user install, desktop and Start menu shortcuts),
  - macOS: `Iron-Proxy-<version>-x64.dmg`, `Iron-Proxy-<version>-arm64.dmg` and matching `-mac.zip` files,
  - Linux: an `.AppImage` and a `.deb` (x64);
- computes `SHA256SUMS.txt` over every installer;
- for a pushed tag, creates the GitHub Release `tray-v<version>` with every installer and `SHA256SUMS.txt` attached, using the workflow's `GITHUB_TOKEN`. A manual run (Run workflow in the Actions tab), on a branch or even on a `tray-v*` tag, only uploads the installers as workflow artifacts: only a pushed tag creates a release.

The builds are **not code-signed**: Windows installers carry no signature and the macOS app is only ad-hoc signed and not notarised, so SmartScreen and Gatekeeper warn on first launch. The release body and [apps/tray/README.md](../apps/tray/README.md#install) give users the exact steps. Signing and notarisation are open items in [ROADMAP.md](ROADMAP.md).

### Cut a tray release

1. Set the version in `apps/tray/package.json` (the tag must match it; the workflow checks). Commit to `main`.
2. Optionally dry-run: Actions → **Tray release** → Run workflow on `main`, then download the `installers-all` artifact and try an installer.
3. Tag and push:

   ```bash
   git tag tray-v0.2.0
   git push origin tray-v0.2.0
   ```

4. When the workflow is green, open the release, download `SHA256SUMS.txt`, and smoke-test at least the Windows x64 installer and one dmg.

To try packaging locally without a release: `pnpm build && pnpm -F @iron-proxy/tray dist:dir` (an unpacked app in `apps/tray/release/`, ignored by git) or `pnpm -F @iron-proxy/tray dist` (installers for the OS you are on). Both download Electron and electron-builder's tools on first use.

### Update the package manifests

`packaging/` holds the winget manifests and the Homebrew cask with placeholder hashes. Fill them from the release's checksums:

```bash
gh release download tray-v0.2.0 --pattern SHA256SUMS.txt --dir /tmp/tray-0.2.0
node scripts/update-manifests.mjs 0.2.0 /tmp/tray-0.2.0/SHA256SUMS.txt
```

It writes the version, the download URLs (`https://github.com/RealDealCPA-VR/Iron-Proxy/releases/download/tray-v0.2.0/<file>`) and the SHA-256 of each Windows installer and dmg into:

- `packaging/winget/RealDealCPA.IronProxy.yaml`, `.installer.yaml`, `.locale.en-US.yaml`
- `packaging/homebrew/iron-proxy.rb`

It changes nothing when run again with the same input, and refuses (touching no file) when `SHA256SUMS.txt` lacks an installer. Commit the result.

### Submit to winget (manual)

1. Fork [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs).
2. Copy the three files from `packaging/winget/` to `manifests/r/RealDealCPA/IronProxy/<version>/` in the fork.
3. Validate and test on Windows: `winget validate --manifest <that folder>` and `winget install --manifest <that folder>` (needs `winget settings --enable LocalManifestFiles` once, from an administrator prompt).
4. Open a pull request to `microsoft/winget-pkgs` titled `New package: RealDealCPA.IronProxy version <version>` (later: `New version: …`). Automated checks and a moderator review follow; unsigned installers are accepted but may get extra scrutiny.

After it merges, `winget install RealDealCPA.IronProxy` works.

### Publish the Homebrew cask (manual)

1. Create the public repository **`RealDealCPA-VR/homebrew-tap`** once (the `homebrew-` prefix is what makes `brew tap realdealcpa-vr/tap` work).
2. Copy `packaging/homebrew/iron-proxy.rb` to `Casks/iron-proxy.rb` in that repository.
3. On a Mac: `brew tap realdealcpa-vr/tap && brew audit --cask --strict realdealcpa-vr/tap/iron-proxy && brew install --cask realdealcpa-vr/tap/iron-proxy`.
4. Commit and push the tap.

After that, `brew install --cask realdealcpa-vr/tap/iron-proxy` works. The cask's `zap` removes only the app's own Electron folders, never `~/.iron-proxy`, which holds the accounts shared with the CLI.
