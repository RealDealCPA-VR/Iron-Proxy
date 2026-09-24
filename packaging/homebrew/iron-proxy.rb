# Homebrew cask for the Iron-Proxy tray app. Filled in by scripts/update-manifests.mjs and
# published by hand to the RealDealCPA-VR/homebrew-tap repository (see docs/RELEASING.md).
# The all-zero hashes are placeholders until the first packaged release.
cask "iron-proxy" do
  version "0.1.0"

  on_arm do
    url "https://github.com/RealDealCPA-VR/Iron-Proxy/releases/download/tray-v0.1.0/Iron-Proxy-0.1.0-arm64.dmg"
    sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  end
  on_intel do
    url "https://github.com/RealDealCPA-VR/Iron-Proxy/releases/download/tray-v0.1.0/Iron-Proxy-0.1.0-x64.dmg"
    sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  end

  name "Iron-Proxy"
  desc "Switch between AI subscription accounts from the menu bar"
  homepage "https://github.com/RealDealCPA-VR/Iron-Proxy"

  depends_on macos: ">= :big_sur"

  app "Iron-Proxy.app"

  # Only the app's own Electron folders. ~/.iron-proxy holds the accounts it shares with the
  # iron-proxy CLI and is never removed by the cask.
  zap trash: [
    "~/Library/Application Support/Iron-Proxy",
    "~/Library/Preferences/com.realdealcpa.ironproxy.plist",
  ]

  caveats <<~EOS
    Iron-Proxy is not notarized by Apple. If macOS says it cannot be opened, right-click
    Iron-Proxy in Applications and choose Open, or run:
      xattr -dr com.apple.quarantine /Applications/Iron-Proxy.app
  EOS
end
