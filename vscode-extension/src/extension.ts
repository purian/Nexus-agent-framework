import * as vscode from "vscode";
import { NexusClient } from "./client";
import { NexusChatProvider } from "./chat-provider";

let client: NexusClient | undefined;
let chatProvider: NexusChatProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  // Create client from configuration
  const config = vscode.workspace.getConfiguration("nexus");
  client = new NexusClient(
    config.get("serverUrl", "http://127.0.0.1:3000"),
    config.get("authToken", "")
  );

  // Register chat webview provider
  chatProvider = new NexusChatProvider(context.extensionUri, client);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("nexus-chat", chatProvider)
  );

  // Output channel for logs
  const outputChannel = vscode.window.createOutputChannel("Nexus Agent");
  context.subscriptions.push(outputChannel);

  // Forward client events to output channel
  client.on("log", (data) => {
    const msg = typeof data === "string" ? data : JSON.stringify(data);
    outputChannel.appendLine(`[Nexus] ${msg}`);
  });

  // --------------------------------------------------------------------------
  // Commands
  // --------------------------------------------------------------------------

  context.subscriptions.push(
    vscode.commands.registerCommand("nexus.start", async () => {
      if (!client) return;
      try {
        await client.connect();
        vscode.window.showInformationMessage("Nexus session started.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to start Nexus session: ${msg}`);
      }
    }),

    vscode.commands.registerCommand("nexus.stop", async () => {
      if (!client) return;
      client.disconnect();
      vscode.window.showInformationMessage("Nexus session stopped.");
    }),

    vscode.commands.registerCommand("nexus.send", async () => {
      if (!client) return;
      const content = await vscode.window.showInputBox({
        prompt: "Enter a message for Nexus",
        placeHolder: "Ask Nexus something...",
      });
      if (!content) return;

      try {
        await client.sendMessage(content);
        chatProvider?.postMessage({ type: "userMessage", content });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to send message: ${msg}`);
      }
    }),

    vscode.commands.registerCommand("nexus.approveAction", async () => {
      if (!client) return;
      chatProvider?.postMessage({ type: "actionDecision", decision: "approve" });
      vscode.window.showInformationMessage("Action approved.");
    }),

    vscode.commands.registerCommand("nexus.denyAction", async () => {
      if (!client) return;
      chatProvider?.postMessage({ type: "actionDecision", decision: "deny" });
      vscode.window.showInformationMessage("Action denied.");
    })
  );

  // Auto-start if configured
  if (config.get("autoStart", false)) {
    vscode.commands.executeCommand("nexus.start");
  }
}

export function deactivate() {
  client?.disconnect();
}
