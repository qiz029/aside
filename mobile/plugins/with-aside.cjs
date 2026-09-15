const {
  withAndroidManifest,
  withAppBuildGradle,
} = require("expo/config-plugins");
module.exports = function (config) {
  config = withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application[0];
    if (process.env.ASIDE_TEST_API === "1")
      app.$["android:usesCleartextTraffic"] = "true";
    else delete app.$["android:usesCleartextTraffic"];
    return config;
  });
  return withAppBuildGradle(config, (config) => {
    let source = config.modResults.contents;
    const marker = "// Aside local release signing";
    if (!source.includes(marker)) {
      source = source.replace(
        "    signingConfigs {",
        `    ${marker}
    signingConfigs {
        asideInternal {
            if (System.getenv("ASIDE_ANDROID_KEYSTORE")) {
                storeFile file(System.getenv("ASIDE_ANDROID_KEYSTORE"))
                storePassword System.getenv("ASIDE_ANDROID_STORE_PASSWORD")
                keyAlias "aside-internal"
                keyPassword System.getenv("ASIDE_ANDROID_STORE_PASSWORD")
            }
        }`,
      );
      source = source.replace(
        /(release\s*\{[\s\S]*?)signingConfig signingConfigs.debug/,
        '$1signingConfig System.getenv("ASIDE_ANDROID_KEYSTORE") ? signingConfigs.asideInternal : signingConfigs.debug',
      );
    }
    config.modResults.contents = source;
    return config;
  });
};
