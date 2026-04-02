import * as vscode from "vscode";
import type { NexusClient } from "./client";

// ============================================================================
// NexusChatProvider — Webview panel for the Nexus chat interface
// ============================================================================

export class NexusChatProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private client: NexusClient;

  constructor(
    private readonly extensionUri: vscode.Uri,
    client: NexusClient
  ) {
    this.client = client;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent();

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.type === "send") {
        try {
          await this.client.sendMessage(message.content);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Nexus: ${msg}`);
        }
      }
    });

    // Forward engine events from server to the webview
    this.client.on("event", (data) => {
      webviewView.webview.postMessage({ type: "event", data });
    });
  }

  /** Post a message to the webview */
  postMessage(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  // --------------------------------------------------------------------------
  // HTML Content
  // --------------------------------------------------------------------------

  private getHtmlContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Nexus Chat</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
    }

    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .message {
      max-width: 85%;
      padding: 8px 12px;
      border-radius: 8px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    .message.user {
      align-self: flex-end;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .message.assistant {
      align-self: flex-start;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
    }

    .tool-block {
      margin: 4px 0;
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 4px;
      overflow: hidden;
    }

    .tool-block summary {
      padding: 4px 8px;
      cursor: pointer;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      font-size: 0.9em;
      opacity: 0.8;
    }

    .tool-block pre {
      padding: 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      overflow-x: auto;
    }

    #input-area {
      display: flex;
      gap: 4px;
      padding: 8px;
      border-top: 1px solid var(--vscode-editorWidget-border);
      background: var(--vscode-sideBar-background);
    }

    #input-area input {
      flex: 1;
      padding: 6px 10px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-family: inherit;
      font-size: inherit;
      outline: none;
    }

    #input-area input:focus {
      border-color: var(--vscode-focusBorder);
    }

    #input-area button {
      padding: 6px 14px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-family: inherit;
      font-size: inherit;
    }

    #input-area button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .status {
      text-align: center;
      padding: 4px;
      font-size: 0.85em;
      opacity: 0.7;
    }
  </style>
</head>
<body>
  <div id="messages">
    <div class="status">Connect to a Nexus server to start chatting.</div>
  </div>
  <div id="input-area">
    <input id="input" type="text" placeholder="Send a message..." />
    <button id="send-btn">Send</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById("messages");
    const inputEl = document.getElementById("input");
    const sendBtn = document.getElementById("send-btn");

    // ------ Send message ------
    function sendMessage() {
      const content = inputEl.value.trim();
      if (!content) return;
      inputEl.value = "";
      addMessage("user", content);
      vscode.postMessage({ type: "send", content });
    }

    sendBtn.addEventListener("click", sendMessage);
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // ------ Receive messages from extension ------
    let currentAssistantEl = null;

    window.addEventListener("message", (e) => {
      const msg = e.data;

      if (msg.type === "userMessage") {
        addMessage("user", msg.content);
        return;
      }

      if (msg.type === "event") {
        handleEvent(msg.data);
        return;
      }

      if (msg.type === "actionDecision") {
        addMessage("assistant", "Action " + msg.decision + "d.");
        return;
      }
    });

    function handleEvent(event) {
      if (!event || !event.type) return;

      switch (event.type) {
        case "text":
          if (!currentAssistantEl) {
            currentAssistantEl = addMessage("assistant", "");
          }
          currentAssistantEl.textContent += event.text;
          scrollToBottom();
          break;

        case "tool_start":
          const block = document.createElement("details");
          block.className = "tool-block";
          block.innerHTML =
            "<summary>" + escapeHtml(event.toolName) + "</summary>" +
            "<pre>" + escapeHtml(JSON.stringify(event.input, null, 2)) + "</pre>";
          messagesEl.appendChild(block);
          scrollToBottom();
          break;

        case "tool_end":
          const resultBlock = document.createElement("details");
          resultBlock.className = "tool-block";
          resultBlock.innerHTML =
            "<summary>Result" + (event.isError ? " (error)" : "") + "</summary>" +
            "<pre>" + escapeHtml(event.result) + "</pre>";
          messagesEl.appendChild(resultBlock);
          scrollToBottom();
          break;

        case "done":
        case "turn_end":
          currentAssistantEl = null;
          break;

        case "error":
          addMessage("assistant", "Error: " + (event.error?.message || "Unknown error"));
          currentAssistantEl = null;
          break;
      }
    }

    // ------ Helpers ------
    function addMessage(role, content) {
      // Remove status message on first real message
      const status = messagesEl.querySelector(".status");
      if (status) status.remove();

      const el = document.createElement("div");
      el.className = "message " + role;
      el.textContent = content;
      messagesEl.appendChild(el);
      scrollToBottom();
      return el;
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function escapeHtml(text) {
      const div = document.createElement("div");
      div.textContent = text;
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
  }
}
