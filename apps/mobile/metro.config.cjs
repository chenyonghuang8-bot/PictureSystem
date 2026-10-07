const { getDefaultConfig } = require("expo/metro-config");
const fs = require("node:fs");
const path = require("node:path");
const config = getDefaultConfig(__dirname);
if (!config.resolver.assetExts.includes("wasm"))
  config.resolver.assetExts.push("wasm");
// Workspace NodeNext sources use .js specifiers for emitted code; resolve only
// existing TS siblings after normal resolution fails, without changing server exports.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  try {
    return context.resolveRequest(context, moduleName, platform);
  } catch (error) {
    const root = path.resolve(__dirname, "../..");
    if (
      moduleName.startsWith(".") &&
      moduleName.endsWith(".js") &&
      context.originModulePath.startsWith(root + path.sep)
    ) {
      const base = path.resolve(
        path.dirname(context.originModulePath),
        moduleName.slice(0, -3),
      );
      if (fs.existsSync(base + ".ts") || fs.existsSync(base + ".tsx"))
        return context.resolveRequest(
          context,
          moduleName.slice(0, -3),
          platform,
        );
    }
    throw error;
  }
};
module.exports = config;
