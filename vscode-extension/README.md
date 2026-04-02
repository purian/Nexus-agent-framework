# Nexus Agent — VS Code Extension

AI agent framework integration for VS Code. Connects to a running Nexus Web UI server to provide an in-editor chat interface with full agent capabilities.

## Prerequisites

- A running Nexus instance with the Web UI server enabled
- Node.js 20+

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `nexus.serverUrl` | `http://127.0.0.1:3000` | URL of the Nexus Web UI server |
| `nexus.authToken` | (empty) | Authentication token for the server |
| `nexus.autoStart` | `false` | Auto-start a session on activation |

## Commands

| Command | Description |
|---------|-------------|
| `Nexus: Start Agent Session` | Connect to the server and create a session |
| `Nexus: Stop Agent Session` | Disconnect from the server |
| `Nexus: Send Message` | Send a message via input box |
| `Nexus: Approve Pending Action` | Approve a pending permission request |
| `Nexus: Deny Pending Action` | Deny a pending permission request |

## Build & Install

```bash
cd vscode-extension
npm install
npm run compile
npm run package   # produces a .vsix file
code --install-extension nexus-agent-0.1.0.vsix
```

## Development

```bash
npm run watch     # recompile on changes
# Press F5 in VS Code to launch the Extension Development Host
```
