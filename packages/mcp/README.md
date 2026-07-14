# @mrpatpat/reqly-mcp

Universal MCP server for Reqly. It exposes requirements, verifications, validation, status changes, and relation mutations over stdio, so Codex, Claude, Cursor, and other MCP clients can use Reqly without VS Code.

The server operates on the current working directory by default. Set `REQLY_ROOT` when the Reqly repository is elsewhere.

Install it directly from the agent's terminal:

Codex:

```sh
codex mcp add reqly -- npx -y @mrpatpat/reqly-mcp
```

Claude Code:

```sh
claude mcp add reqly -- npx -y @mrpatpat/reqly-mcp
```

Example Codex configuration:

```toml
[mcp_servers.reqly]
command = "npx"
args = ["-y", "@mrpatpat/reqly-mcp"]
```
