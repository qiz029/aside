const { getDefaultConfig } = require("expo/metro-config");
const config = getDefaultConfig(__dirname);
config.resolver.useWatchman = false;
config.maxWorkers = 2;
// The web workspace may use a newer React. Every native module must resolve
// the same React instance as the native renderer, including hoisted modules.
config.resolver.resolveRequest = (context, name, platform) => {
  if (name === "react" || name.startsWith("react/"))
    return {
      type: "sourceFile",
      filePath: require.resolve(name, { paths: [__dirname] }),
    };
  return context.resolveRequest(context, name, platform);
};
module.exports = config;
