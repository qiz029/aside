const {
  withXcodeProject,
  withInfoPlist,
  withEntitlementsPlist,
  IOSConfig,
} = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");
const plist = require("@expo/plist").default;
module.exports = function (config) {
  const group = `group.${config.ios.bundleIdentifier}`;
  config = withInfoPlist(config, (c) => {
    c.modResults.AsideAppGroup = group;
    return c;
  });
  config = withEntitlementsPlist(config, (c) => {
    c.modResults["com.apple.security.application-groups"] = [
      ...new Set([
        ...(c.modResults["com.apple.security.application-groups"] || []),
        group,
      ]),
    ];
    return c;
  });
  return withXcodeProject(config, (c) => {
    const p = c.modResults,
      root = c.modRequest.platformProjectRoot,
      main = c.modRequest.projectName;
    for (const name of [
      "AsidePodcastInbox.swift",
      "AsidePodcastInboxBridge.m",
    ]) {
      fs.copyFileSync(
        path.join(__dirname, "../native", name),
        path.join(root, main, name),
      );
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath: `${main}/${name}`,
        groupName: main,
        project: p,
      });
    }
    const name = "PodcastShare";
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, "../native/PodcastShare/ShareViewController.swift"),
      path.join(dir, "ShareViewController.swift"),
    );
    fs.writeFileSync(
      path.join(dir, `${name}-Info.plist`),
      plist.build({
        CFBundleDisplayName: "Aside",
        CFBundleIdentifier: "$(PRODUCT_BUNDLE_IDENTIFIER)",
        CFBundleExecutable: "$(EXECUTABLE_NAME)",
        CFBundleName: "$(PRODUCT_NAME)",
        CFBundlePackageType: "XPC!",
        CFBundleShortVersionString: config.version,
        CFBundleVersion: config.ios.buildNumber || "1",
        AsideAppGroup: group,
        NSExtension: {
          NSExtensionPointIdentifier: "com.apple.share-services",
          NSExtensionPrincipalClass:
            "$(PRODUCT_MODULE_NAME).ShareViewController",
          NSExtensionAttributes: {
            NSExtensionActivationRule: {
              NSExtensionActivationSupportsWebURLWithMaxCount: 1,
              NSExtensionActivationSupportsText: true,
            },
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(dir, `${name}.entitlements`),
      plist.build({ "com.apple.security.application-groups": [group] }),
    );
    const targets = p.pbxNativeTargetSection();
    let id = Object.keys(targets).find(
      (k) => targets[k]?.name?.replace(/"/g, "") === name,
    );
    if (!id) {
      const target = p.addTarget(
        name,
        "app_extension",
        name,
        `${config.ios.bundleIdentifier}.PodcastShare`,
      );
      id = target.uuid;
      const files = p.addPbxGroup(
        [
          "ShareViewController.swift",
          `${name}-Info.plist`,
          `${name}.entitlements`,
        ],
        name,
        name,
      );
      p.addToPbxGroup(files.uuid, p.getFirstProject().firstProject.mainGroup);
      p.addBuildPhase(
        [`${name}/ShareViewController.swift`],
        "PBXSourcesBuildPhase",
        "Sources",
        id,
      );
      p.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", id);
      p.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", id);
    }
    const target = p.pbxNativeTargetSection()[id];
    const configs =
      p.pbxXCConfigurationList()[target.buildConfigurationList]
        .buildConfigurations;
    for (const ref of configs) {
      Object.assign(
        p.pbxXCBuildConfigurationSection()[ref.value].buildSettings,
        {
          SWIFT_VERSION: "5.0",
          IPHONEOS_DEPLOYMENT_TARGET: "15.1",
          TARGETED_DEVICE_FAMILY: '"1,2"',
          CODE_SIGN_ENTITLEMENTS: `${name}/${name}.entitlements`,
          APPLICATION_EXTENSION_API_ONLY: "YES",
          GENERATE_INFOPLIST_FILE: "NO",
          CODE_SIGN_STYLE: "Automatic",
          ...(config.ios.appleTeamId
            ? { DEVELOPMENT_TEAM: config.ios.appleTeamId }
            : {}),
        },
      );
    }
    return c;
  });
};
