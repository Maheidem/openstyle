// electron-builder sign hook (-c.mac.sign) for local builds with a hash identity.
//
// electron-builder 26 gives @electron/osx-sign the identity NAME, not its hash
// (app-builder-lib macPackager doSign), and turns identity validation off, so
// codesign looks the name up again. On the owner's Mac that lookup fails for a
// name with "é" ("no identity found", 2026-10-23). A custom sign hook gets
// `identity.hash || identity.name` instead, so codesign signs by hash.
const { createRequire } = require("node:module");

const builder = require.resolve("electron-builder");
const appBuilderLib = createRequire(builder).resolve("app-builder-lib");
const { signAsync } = createRequire(appBuilderLib)("@electron/osx-sign");

module.exports = async (opts) => signAsync(opts);
