import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  devSign,
  devSignIdentity,
} from "../../apps/electron/scripts/dev-sign.mjs";

if (!devSignIdentity()) {
  console.error(
    "Openstyle Dev identity missing: the owner runs ! bash scripts/dev-signing-setup.sh once",
  );
  process.exit(1);
}

const bundlePath = join(homedir(), "Applications", "Openstyle Test Runner.app");
const contents = join(bundlePath, "Contents");
const macos = join(contents, "MacOS");
mkdirSync(macos, { recursive: true });
execFileSync(
  "swiftc",
  [
    "-O",
    "-target",
    "arm64-apple-macos14.0",
    "scripts/test-runner/runner.swift",
    "-o",
    join(macos, "openstyle-test-runner"),
  ],
  { stdio: "inherit" },
);
writeFileSync(
  join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.openstyle.test-runner</string>
<key>CFBundleName</key><string>Openstyle Test Runner</string>
<key>CFBundleExecutable</key><string>openstyle-test-runner</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>14.0</string>
</dict></plist>
`,
);
if (!devSign([bundlePath], { deep: true })) {
  console.error("Failed to sign Openstyle Test Runner with the dev identity");
  process.exit(1);
}
console.log(bundlePath);
