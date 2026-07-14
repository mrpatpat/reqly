export default {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    ["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
    ["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
    ["@semantic-release/exec", {
      verifyConditionsCmd: "node scripts/verify-vscode-marketplace.mjs",
      prepareCmd: "node scripts/prepare-vscode-release.mjs ${nextRelease.version}",
      publishCmd: "npx --no-install vsce publish --packagePath release/reqly-vscode-${nextRelease.version}.vsix --skip-duplicate",
    }],
    ["@semantic-release/npm", { pkgRoot: "packages/core", npmPublish: true }],
    ["@semantic-release/npm", { pkgRoot: "packages/mcp", npmPublish: true }],
    ["@semantic-release/github", {
      assets: [
        { path: "release/*.vsix", label: "Reqly VS Code extension" },
        { path: "release/*.sha256", label: "SHA-256 checksum" },
      ],
      successComment: false,
      failComment: false,
    }],
  ],
};
