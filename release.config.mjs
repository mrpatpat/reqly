export default {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    ["@semantic-release/commit-analyzer", { preset: "conventionalcommits" }],
    ["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
    ["@semantic-release/exec", {
      prepareCmd: "node scripts/prepare-vscode-release.mjs ${nextRelease.version}",
      publishCmd: "npx @vscode/vsce publish --packagePath release/reqly-vscode-${nextRelease.version}.vsix",
    }],
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
