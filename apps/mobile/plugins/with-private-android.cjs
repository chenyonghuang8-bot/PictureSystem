const {
  withAndroidManifest,
  withDangerousMod,
  withAppBuildGradle,
} = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");
module.exports = (config) => {
  config = withAndroidManifest(config, (c) => {
    const app = c.modResults.manifest.application[0];
    c.modResults.manifest["uses-permission"] = (
      c.modResults.manifest["uses-permission"] || []
    ).filter(
      (p) =>
        ![
          "android.permission.READ_EXTERNAL_STORAGE",
          "android.permission.WRITE_EXTERNAL_STORAGE",
          "android.permission.SYSTEM_ALERT_WINDOW",
        ].includes(p.$["android:name"]),
    );
    for (const name of [
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.VIBRATE",
      "android.permission.USE_BIOMETRIC",
      "android.permission.USE_FINGERPRINT",
    ]) {
      c.modResults.manifest["uses-permission"].push({
        $: { "android:name": name, "tools:node": "remove" },
      });
    }
    app.$["android:allowBackup"] = "false";
    app.$["android:fullBackupContent"] = "@xml/private_backup_rules";
    app.$["android:dataExtractionRules"] = "@xml/private_extraction_rules";
    app.$["android:usesCleartextTraffic"] = "false";
    app.$["android:networkSecurityConfig"] = "@xml/network_security_config";
    return c;
  });
  config = withAppBuildGradle(config, (c) => {
    c.modResults.contents = c.modResults.contents.replace(
      /\n\s*applicationIdSuffix ".dev"/g,
      "",
    );
    c.modResults.contents = c.modResults.contents.replace(
      /buildTypes\s*\{\s*debug\s*\{/,
      'buildTypes {\n        debug {\n            applicationIdSuffix ".dev"',
    );
    c.modResults.contents = c.modResults.contents.replace(
      /react \{/,
      "react {\n    debuggableVariants = []",
    );
    c.modResults.contents = c.modResults.contents.replace(
      /(release\s*\{[\s\S]*?)signingConfig signingConfigs.debug/,
      "$1",
    );
    if (!c.modResults.contents.includes("PHASE10_FORMAL_RELEASE_GATE"))
      c.modResults.contents += `
// PHASE10_FORMAL_RELEASE_GATE: debug is not a formally signed delivery.
tasks.matching { it.name == "assembleRelease" || it.name == "bundleRelease" }.configureEach {
  doFirst {
    def origin = System.getenv("EXPO_PUBLIC_API_ORIGIN")
    if (origin == null || !origin.startsWith("https://") || origin.contains("10.0.2.2") || origin.contains("localhost") || origin.contains("127.0.0.1")) {
      throw new GradleException("A configured release HTTPS origin and user-managed signing configuration are required.")
    }
  }
}
`;
    return c;
  });
  return withDangerousMod(config, [
    "android",
    async (c) => {
      const root = c.modRequest.platformProjectRoot;
      const dir = path.join(root, "app/src/main/res/xml");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "network_security_config.xml"),
        '<network-security-config><base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system"/></trust-anchors></base-config></network-security-config>',
      );
      fs.writeFileSync(
        path.join(dir, "private_backup_rules.xml"),
        '<full-backup-content><exclude domain="root" path="."/><exclude domain="file" path="."/><exclude domain="database" path="."/><exclude domain="sharedpref" path="."/><exclude domain="external" path="."/></full-backup-content>',
      );
      const exclusions =
        '<exclude domain="root" path="."/><exclude domain="file" path="."/><exclude domain="database" path="."/><exclude domain="sharedpref" path="."/><exclude domain="external" path="."/>';
      fs.writeFileSync(
        path.join(dir, "private_extraction_rules.xml"),
        "<data-extraction-rules><cloud-backup>" +
          exclusions +
          "</cloud-backup><device-transfer>" +
          exclusions +
          "</device-transfer></data-extraction-rules>",
      );
      for (const variant of ["debug", "debugOptimized"]) {
        const manifest = path.join(
          root,
          "app/src",
          variant,
          "AndroidManifest.xml",
        );
        if (fs.existsSync(manifest))
          fs.writeFileSync(
            manifest,
            '<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools"><application android:usesCleartextTraffic="false" tools:replace="android:usesCleartextTraffic" /></manifest>',
          );
      }
      const appFile = path.join(
        root,
        "app/src/main/java/local/familyalbum/app/MainApplication.kt",
      );
      if (fs.existsSync(appFile)) {
        const content = fs.readFileSync(appFile, "utf8");
        if (!content.includes("useDevSupport = false"))
          fs.writeFileSync(
            appFile,
            content.replace(
              "context = applicationContext,",
              "context = applicationContext,\n      useDevSupport = false,",
            ),
          );
      }
      const ca = process.env.EXPO_DEV_CA_FILE;
      if (ca) {
        const pem = fs.readFileSync(ca, "utf8");
        if (!pem.includes("BEGIN CERTIFICATE") || pem.includes("PRIVATE KEY"))
          throw new Error("DEV_CA_INVALID");
        const debug = path.join(root, "app/src/debug/res");
        fs.mkdirSync(path.join(debug, "raw"), { recursive: true });
        fs.mkdirSync(path.join(debug, "xml"), { recursive: true });
        fs.writeFileSync(path.join(debug, "raw/dev_ca.pem"), pem);
        fs.writeFileSync(
          path.join(debug, "xml/network_security_config.xml"),
          '<network-security-config><base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system"/></trust-anchors></base-config><domain-config cleartextTrafficPermitted="false"><domain includeSubdomains="false">10.0.2.2</domain><trust-anchors><certificates src="@raw/dev_ca"/></trust-anchors></domain-config></network-security-config>',
        );
      }
      return c;
    },
  ]);
};
