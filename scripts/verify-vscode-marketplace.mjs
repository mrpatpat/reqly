const token = process.env.VSCE_PAT?.trim();

if (!token) {
  process.stderr.write(
    "VSCE_PAT is required to publish the VS Code extension to the Marketplace.\n",
  );
  process.exit(1);
}

process.stderr.write("VSCE_PAT is available for VS Code Marketplace publishing.\n");
