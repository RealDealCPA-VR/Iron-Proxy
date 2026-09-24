---
'@iron-proxy/core': patch
'@iron-proxy/proxy': patch
'@iron-proxy/electron': patch
'@iron-proxy/react': patch
'iron-proxy': patch
---

Ready for npm: every package now ships its README and the MIT LICENSE in the tarball, publishes with npm provenance, links its repository, homepage and issue tracker, and gives CommonJS consumers their own type declarations (`exports[...].require.types` points at `.d.cts`, `import.types` at `.d.ts`). `pnpm pack:check` checks each tarball's contents before any publish.

Also in this release, not published to npm: the tray app (`apps/tray`) builds installers with electron-builder (Windows NSIS x64 and arm64, macOS dmg and zip for Intel and Apple silicon, Linux AppImage and deb) in a new tag-triggered workflow that attaches them with SHA256SUMS.txt to a GitHub Release. The builds are not code-signed yet; apps/tray/README.md has the first-launch steps. winget and Homebrew manifests live in `packaging/`, and docs/RELEASING.md describes every release step.
