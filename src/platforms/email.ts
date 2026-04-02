import { connect as tlsConnect } from "node:tls";
import { connect as netConnect } from "node:net";
import type { IncomingMessage, PlatformAdapter } from "../types/index.js";

/**
 * Email adapter — IMAP polling for receiving, SMTP for sending.
 *
 * Uses native node:tls/node:net for connections. This is a practical
 * implementation suitable for simple email workflows. For complex email
 * needs, users should use a plugin with a dedicated email library.
 */
export class EmailAdapter implements PlatformAdapter {
  name = "email";
  private imapHost = "";
  private imapPort = 993;
  private smtpHost = "";
  private smtpPort = 587;
  private username = "";
  private password = "";
  private pollInterval = 30000;
  private running = false;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private handler?: (message: IncomingMessage) => void;

  async connect(config: Record<string, unknown>): Promise<void> {
    this.imapHost = config.imapHost as string;
    this.imapPort = (config.imapPort as number) ?? 993;
    this.smtpHost = config.smtpHost as string;
    this.smtpPort = (config.smtpPort as number) ?? 587;
    this.username = config.username as string;
    this.password = config.password as string;
    this.pollInterval = (config.pollInterval as number) ?? 30000;

    if (!this.imapHost) throw new Error("Email: imapHost is required");
    if (!this.smtpHost) throw new Error("Email: smtpHost is required");
    if (!this.username) throw new Error("Email: username is required");
    if (!this.password) throw new Error("Email: password is required");

    this.running = true;
    this.pollLoop();
  }

  async disconnect(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  onMessage(handler: (message: IncomingMessage) => void): void {
    this.handler = handler;
  }

  async sendMessage(chatId: string, content: string): Promise<void> {
    const subject = content.length > 60 ? content.slice(0, 57) + "..." : content;
    await this.sendSMTP(chatId, subject, content);
  }

  private pollLoop(): void {
    if (!this.running) return;
    this.pollForNewMessages().catch(() => {
      // Silently ignore poll errors — retry on next interval
    }).finally(() => {
      if (this.running) {
        this.pollTimer = setTimeout(() => this.pollLoop(), this.pollInterval);
      }
    });
  }

  async pollForNewMessages(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = tlsConnect(
        { host: this.imapHost, port: this.imapPort, rejectUnauthorized: false },
        () => {
          let buffer = "";
          let step = 0;
          let messageData = "";
          let fetchingBody = false;

          const send = (cmd: string) => {
            socket.write(cmd + "\r\n");
          };

          socket.on("data", (data) => {
            buffer += data.toString();

            // Process complete lines
            while (buffer.includes("\r\n") || fetchingBody) {
              if (fetchingBody) {
                // Accumulate body data until we see the closing paren and tagged response
                messageData += buffer;
                buffer = "";
                if (messageData.includes("\r\nA4 OK")) {
                  fetchingBody = false;
                  this.processImapMessage(messageData);
                  send("A5 LOGOUT");
                }
                break;
              }

              const lineEnd = buffer.indexOf("\r\n");
              if (lineEnd === -1) break;
              const line = buffer.slice(0, lineEnd);
              buffer = buffer.slice(lineEnd + 2);

              if (step === 0 && line.includes("OK")) {
                // Server greeting — login
                step = 1;
                send(`A1 LOGIN ${this.username} ${this.password}`);
              } else if (step === 1 && line.startsWith("A1 OK")) {
                // Logged in — select INBOX
                step = 2;
                send("A2 SELECT INBOX");
              } else if (step === 2 && line.startsWith("A2 OK")) {
                // INBOX selected — search unseen
                step = 3;
                send("A3 SEARCH UNSEEN");
              } else if (step === 3 && line.startsWith("* SEARCH")) {
                const ids = line.replace("* SEARCH", "").trim();
                if (!ids) {
                  // No new messages
                  send("A5 LOGOUT");
                  step = 99;
                } else {
                  const firstId = ids.split(" ")[0];
                  step = 4;
                  send(`A4 FETCH ${firstId} (BODY[HEADER.FIELDS (FROM SUBJECT)] BODY[TEXT])`);
                }
              } else if (step === 3 && line.startsWith("A3 OK")) {
                // No SEARCH results line means no messages
                if (step === 3) {
                  send("A5 LOGOUT");
                  step = 99;
                }
              } else if (step === 4 && line.startsWith("*")) {
                fetchingBody = true;
                messageData = line + "\r\n";
              } else if (line.startsWith("A5 OK") || line.includes("BYE")) {
                socket.end();
              }
            }
          });

          socket.on("end", () => resolve());
          socket.on("error", (err) => reject(err));
        },
      );

      socket.on("error", (err) => reject(err));
    });
  }

  private processImapMessage(raw: string): void {
    if (!this.handler) return;

    // Extract From header
    const fromMatch = raw.match(/From:\s*(.+?)(?:\r\n(?!\s)|\r\n\))/i);
    const from = fromMatch ? this.parseEmailAddress(fromMatch[1].trim()) : "unknown";

    // Extract Subject header
    const subjectMatch = raw.match(/Subject:\s*(.+?)(?:\r\n(?!\s)|\r\n\))/i);
    const subject = subjectMatch ? subjectMatch[1].trim() : "";

    // Extract body text (after the empty line separating headers from body)
    const bodyMatch = raw.match(/\r\n\r\n([\s\S]*?)(?:\)\r\n|$)/);
    const body = bodyMatch ? bodyMatch[1].trim() : "";

    this.handler({
      platform: "email",
      chatId: from,
      userId: from,
      text: body || subject,
      metadata: { subject, from },
    });
  }

  parseEmailAddress(raw: string): string {
    // Handle "Display Name <email@example.com>" format
    const match = raw.match(/<([^>]+)>/);
    if (match) return match[1];
    // Already a plain address
    return raw.trim();
  }

  async sendSMTP(to: string, subject: string, body: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = netConnect({ host: this.smtpHost, port: this.smtpPort }, () => {
        let buffer = "";
        let step = 0;
        let upgraded = false;
        // Writable reference so we can swap to TLS socket after STARTTLS
        let writer: { write(data: string): boolean } = socket;

        const send = (cmd: string) => {
          writer.write(cmd + "\r\n");
        };

        const handleLine = (line: string) => {
          const code = parseInt(line.slice(0, 3), 10);

          if (step === 0 && code === 220) {
            step = 1;
            send("EHLO nexus");
          } else if (step === 1 && code === 250 && !upgraded && line.includes("STARTTLS")) {
            // Server supports STARTTLS — upgrade will happen after full response
          } else if (step === 1 && code === 250 && !line.startsWith("250-")) {
            // End of EHLO response
            if (!upgraded) {
              step = 2;
              send("STARTTLS");
            } else {
              step = 3;
              const credentials = Buffer.from(`\0${this.username}\0${this.password}`).toString("base64");
              send(`AUTH PLAIN ${credentials}`);
            }
          } else if (step === 2 && code === 220) {
            // Upgrade to TLS
            upgraded = true;
            const tlsSocket = tlsConnect(
              { socket, host: this.smtpHost, rejectUnauthorized: false },
              () => {
                step = 1;
                tlsSocket.write("EHLO nexus\r\n");
              },
            );
            tlsSocket.on("data", (data) => {
              buffer += data.toString();
              processBuffer();
            });
            tlsSocket.on("error", reject);
            // Swap writer to TLS socket and stop reading from plain socket
            socket.removeAllListeners("data");
            writer = tlsSocket;
          } else if (step === 3 && code === 235) {
            // Auth successful — send MAIL FROM
            step = 4;
            send(`MAIL FROM:<${this.username}>`);
          } else if (step === 4 && code === 250) {
            step = 5;
            send(`RCPT TO:<${to}>`);
          } else if (step === 5 && code === 250) {
            step = 6;
            send("DATA");
          } else if (step === 6 && code === 354) {
            const email = [
              `From: ${this.username}`,
              `To: ${to}`,
              `Subject: ${subject}`,
              "MIME-Version: 1.0",
              "Content-Type: text/plain; charset=utf-8",
              `Date: ${new Date().toUTCString()}`,
              "",
              body,
              ".",
            ].join("\r\n");
            send(email);
            step = 7;
          } else if (step === 7 && code === 250) {
            step = 8;
            send("QUIT");
          } else if (step === 8 && code === 221) {
            socket.end();
            resolve();
          } else if (code >= 400) {
            socket.end();
            reject(new Error(`SMTP error: ${line}`));
          }
        };

        const processBuffer = () => {
          while (buffer.includes("\r\n")) {
            const lineEnd = buffer.indexOf("\r\n");
            const line = buffer.slice(0, lineEnd);
            buffer = buffer.slice(lineEnd + 2);
            handleLine(line);
          }
        };

        socket.on("data", (data) => {
          buffer += data.toString();
          processBuffer();
        });

        socket.on("error", reject);
      });

      socket.on("error", reject);
    });
  }
}
