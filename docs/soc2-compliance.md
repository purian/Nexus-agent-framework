# SOC 2 Compliance Guide for Nexus Agent Framework

**Version:** 1.0
**Last Updated:** 2026-04-02
**Framework Version:** 0.13.0
**Classification:** Internal / Compliance

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [SOC 2 Overview](#soc-2-overview)
3. [Trust Service Criteria Mapping](#trust-service-criteria-mapping)
4. [Detailed Security Feature Analysis](#detailed-security-feature-analysis)
   - [Permission System](#1-permission-system)
   - [Role-Based Access Control](#2-role-based-access-control-rbac)
   - [Audit Logging](#3-audit-logging)
   - [Rate Limiting](#4-rate-limiting)
   - [Encrypted Memory](#5-encrypted-memory)
   - [Sandboxed Execution](#6-sandboxed-execution)
   - [OAuth 2.0 for MCP](#7-oauth-20-for-mcp)
   - [Web Server Authentication](#8-web-server-authentication)
   - [Docker Deployment](#9-docker-deployment)
   - [Hub Security Review](#10-hub-security-review)
   - [Configuration Management](#11-configuration-management)
   - [Self-Host Safety](#12-self-host-safety)
5. [Deployment Checklist for SOC 2-Ready Setup](#deployment-checklist-for-soc-2-ready-setup)
6. [Monitoring and Incident Response](#monitoring-and-incident-response)
7. [Appendix: Sample Configurations](#appendix-sample-configurations)

---

## Executive Summary

The Nexus Agent Framework provides a comprehensive set of security controls that align with SOC 2 Type II Trust Service Criteria (TSC). This guide documents how Nexus's built-in security features -- including fine-grained permissions, role-based access control, audit logging, encryption at rest, sandboxed execution, and authentication mechanisms -- map to the five Trust Service Categories defined by the AICPA.

Organizations deploying Nexus in production can use this guide to:

- **Demonstrate compliance** by mapping Nexus controls to specific SOC 2 criteria
- **Configure security features** according to compliance requirements
- **Prepare for audits** with evidence of control implementation
- **Identify gaps** where additional organizational controls may be needed

Nexus is designed with a defense-in-depth approach. No single feature provides complete compliance; rather, the layered combination of permissions, RBAC, audit trails, encryption, sandboxing, and authentication creates a security posture suitable for SOC 2-regulated environments.

---

## SOC 2 Overview

### What is SOC 2?

SOC 2 (System and Organization Controls 2) is an auditing framework developed by the American Institute of Certified Public Accountants (AICPA). It evaluates an organization's information systems based on five Trust Service Criteria:

| Category | Code | Description |
|---|---|---|
| **Security** | CC | Protection against unauthorized access (the "Common Criteria" -- required for all SOC 2 reports) |
| **Availability** | A | System is available for operation and use as committed |
| **Processing Integrity** | PI | System processing is complete, valid, accurate, timely, and authorized |
| **Confidentiality** | C | Information designated as confidential is protected as committed |
| **Privacy** | P | Personal information is collected, used, retained, disclosed, and disposed of properly |

### SOC 2 Type I vs. Type II

- **Type I** evaluates the design of controls at a specific point in time
- **Type II** evaluates the operating effectiveness of controls over a period (typically 6-12 months)

This guide addresses both types by documenting control design (Type I) and providing monitoring guidance for demonstrating ongoing effectiveness (Type II).

---

## Trust Service Criteria Mapping

The following table provides a high-level mapping of Nexus security features to SOC 2 Trust Service Criteria. Detailed analysis follows in subsequent sections.

### Security (Common Criteria)

| SOC 2 Criterion | Description | Nexus Feature(s) | Coverage |
|---|---|---|---|
| CC1.1 | COSO Principle 1: Demonstrates commitment to integrity and ethical values | Hub Security Review (verified/community/unreviewed), Config validation | Partial |
| CC2.1 | COSO Principle 13: Uses relevant, quality information | Audit Logging, Config Management | Full |
| CC3.1 | COSO Principle 6: Specifies suitable risk management objectives | Permission System (4 modes), RBAC, Rate Limiting | Full |
| CC5.1 | COSO Principle 10: Selects and develops control activities | Permission System, RBAC, Sandbox, Encryption | Full |
| CC5.2 | COSO Principle 11: Selects and develops technology controls | All security features combined | Full |
| CC6.1 | Logical and physical access controls | Permission System, RBAC, OAuth 2.0, Web Auth | Full |
| CC6.2 | System credentials and authentication mechanisms | OAuth 2.0, Bearer Token Auth, API key management | Full |
| CC6.3 | Authorization to access based on need | RBAC (admin/developer/viewer), Per-tool rules | Full |
| CC6.6 | Restricts access to system boundaries | Sandbox (Docker isolation), Network controls | Full |
| CC6.7 | Restricts data movement | Sandbox network modes (none/bridge/host), Read-only mounts | Full |
| CC6.8 | Prevents and detects unauthorized software | Self-Host Safety (safe/denied command lists) | Partial |
| CC7.1 | Detection of changes to infrastructure and software | Audit Logging (all tool executions) | Full |
| CC7.2 | Monitoring for anomalies and security events | Audit Logging, Rate Limiting (anomaly detection via thresholds) | Full |
| CC7.3 | Evaluates security events | Audit log analysis (JSONL format for SIEM integration) | Full |
| CC7.4 | Responds to identified security events | Rate Limiting (auto-throttle), Permission deny, Sandbox timeout | Partial |
| CC8.1 | Changes to infrastructure and software are authorized | Permission System (4-layer priority), Config validation (Zod) | Full |

### Availability

| SOC 2 Criterion | Description | Nexus Feature(s) | Coverage |
|---|---|---|---|
| A1.1 | Processing capacity to meet commitments | Rate Limiting (sliding window, per-tool/per-agent limits) | Full |
| A1.2 | Recovery procedures | Fail-safe audit logging, Sandbox auto-cleanup, Docker restart policies | Partial |
| A1.3 | Recovery testing | Sandbox timeout enforcement, Encrypted memory backward compatibility | Partial |

### Processing Integrity

| SOC 2 Criterion | Description | Nexus Feature(s) | Coverage |
|---|---|---|---|
| PI1.1 | System processing is complete, valid, accurate | Permission decision logging, Zod config validation | Full |
| PI1.2 | Inputs are complete, valid, and accurate | Config schema validation (Zod), Permission rule parsing | Full |
| PI1.3 | Processing outputs are complete and accurate | Audit log (output capture, error tracking, duration) | Full |
| PI1.4 | Detects and reports processing errors | Audit log (isError field), Rate limit decisions, Permission denials | Full |

### Confidentiality

| SOC 2 Criterion | Description | Nexus Feature(s) | Coverage |
|---|---|---|---|
| C1.1 | Identifies and maintains confidential information | Encrypted Memory (per-field encryption), Sensitive data scrubbing | Full |
| C1.2 | Disposes of confidential information | Sandbox auto-cleanup, Container removal, Encrypted storage | Partial |

### Privacy

| SOC 2 Criterion | Description | Nexus Feature(s) | Coverage |
|---|---|---|---|
| P1.1 | Notice of privacy practices | Config-driven data handling, Audit log retention policies | Partial |
| P3.1 | Collects information for identified purposes | Audit log fields are predefined and documented | Full |
| P4.1 | Uses information only for identified purposes | Permission System restricts tool access, RBAC limits scope | Full |
| P6.1 | Provides data subjects access to their information | Audit logs in human-readable JSONL format | Partial |

---

## Detailed Security Feature Analysis

### 1. Permission System

**Source:** `src/permissions/index.ts` (335 lines)

The Permission System is Nexus's primary access control mechanism. It evaluates every tool invocation against a layered rule set before execution is permitted.

#### Permission Modes

| Mode | Behavior | SOC 2 Use Case |
|---|---|---|
| `default` | Prompts the user for each unmatched tool invocation | Development environments, interactive use |
| `allowAll` | Permits all tool invocations without prompting | Trusted automation (NOT recommended for SOC 2) |
| `denyAll` | Blocks all tool invocations unless explicitly allowed | High-security environments, production agents |
| `plan` | Read-only mode; only observation tools are permitted | Auditing, compliance review, read-only agents |

#### 4-Layer Priority System

Rules are resolved with a deterministic priority order (highest priority wins):

```
cli (3) > session (2) > project (1) > user (0)
```

This enables organizations to enforce security policies at the user level while allowing project-specific overrides and session-level adjustments, with CLI flags taking ultimate precedence.

#### Per-Tool Rules with Glob Pattern Matching

Rules can target specific tool invocations with granular input pattern matching:

```json
{
  "permissionRules": [
    {
      "toolName": "Bash",
      "pattern": "git *",
      "behavior": "allow",
      "source": "project"
    },
    {
      "toolName": "Bash",
      "pattern": "rm -rf *",
      "behavior": "deny",
      "source": "project"
    },
    {
      "toolName": "Bash",
      "pattern": "sudo *",
      "behavior": "deny",
      "source": "project"
    },
    {
      "toolName": "WriteFile",
      "behavior": "ask",
      "source": "project"
    }
  ]
}
```

#### SOC 2 Relevance

- **CC6.1 / CC6.3:** The permission system provides logical access controls scoped to individual tools and input patterns, enforcing the principle of least privilege.
- **CC8.1:** The 4-layer priority system ensures that security policies can be centrally managed (user layer) with controlled override paths.
- **PI1.2:** Input pattern matching validates the nature of tool invocations before they execute.

#### Compliance Recommendation

For SOC 2-regulated deployments, use `denyAll` as the base permission mode and explicitly allow only required tools:

```json
{
  "permissionMode": "denyAll",
  "permissionRules": [
    { "toolName": "Read", "behavior": "allow", "source": "project" },
    { "toolName": "Grep", "behavior": "allow", "source": "project" },
    { "toolName": "Glob", "behavior": "allow", "source": "project" }
  ]
}
```

---

### 2. Role-Based Access Control (RBAC)

**Source:** `src/permissions/rbac.ts` (275 lines)

The RBAC system extends the Permission System with role-based abstractions, enabling organizations to define security profiles for different agent types.

#### Built-in Roles

| Role | Description | Permitted Tools |
|---|---|---|
| `admin` | Full access to all tools | `*` (wildcard allow) |
| `developer` | Read/write access with dangerous pattern restrictions | Read, Write, Edit, Grep, Glob, WebFetch, Bash (with restrictions) |
| `viewer` | Read-only access to safe tools | Read, Grep, Glob, WebFetch |

#### Developer Role Restrictions

The built-in `developer` role includes explicit deny rules for dangerous Bash patterns:

- `rm -rf *` -- destructive file operations
- `sudo *` -- privilege escalation
- `> /dev/*` -- device file manipulation

#### Custom Roles with Inheritance

Organizations can define custom roles that inherit from built-in or other custom roles, building hierarchical permission structures:

```json
{
  "rbac": {
    "roles": [
      {
        "name": "ci-agent",
        "description": "CI/CD pipeline agent with test and build permissions",
        "inherits": ["developer"],
        "permissions": [
          { "toolName": "Bash", "pattern": "npm test", "behavior": "allow", "source": "project" },
          { "toolName": "Bash", "pattern": "npm run build", "behavior": "allow", "source": "project" },
          { "toolName": "Bash", "pattern": "docker *", "behavior": "deny", "source": "project" }
        ]
      },
      {
        "name": "data-analyst",
        "description": "Read-only agent for data analysis tasks",
        "inherits": ["viewer"],
        "permissions": [
          { "toolName": "Bash", "pattern": "psql --readonly *", "behavior": "allow", "source": "project" }
        ]
      }
    ],
    "assignments": [
      { "agentId": "ci-*", "role": "ci-agent" },
      { "agentId": "analyst-*", "role": "data-analyst" },
      { "agentId": "*", "role": "viewer" }
    ],
    "defaultRole": "viewer"
  }
}
```

#### Circular Inheritance Detection

The RBAC system detects and prevents circular inheritance chains (e.g., Role A inherits from Role B, which inherits from Role A), ensuring deterministic permission resolution.

#### Agent-to-Role Assignment with Glob Patterns

Agents are matched to roles using glob patterns on their agent IDs, enabling flexible assignment strategies for multi-agent deployments.

#### SOC 2 Relevance

- **CC6.1 / CC6.3:** RBAC implements the principle of least privilege at the role level, with a secure default (`viewer`) for unassigned agents.
- **CC5.1:** Role definitions serve as documented control activities that can be reviewed by auditors.
- **CC3.1:** The `defaultRole` fallback ensures that unrecognized agents receive minimal permissions.

---

### 3. Audit Logging

**Source:** `src/core/audit-logger.ts` (107 lines)

The Audit Logger captures a tamper-evident record of every tool execution, permission decision, and error condition within the Nexus runtime.

#### Log Format

Audit logs are written in JSONL (JSON Lines) format to `{dataDirectory}/audit.jsonl`. Each entry contains:

| Field | Type | Description |
|---|---|---|
| `timestamp` | ISO 8601 string | Exact time of the tool execution |
| `toolName` | string | Name of the tool invoked |
| `toolUseId` | string | Unique identifier for the tool invocation |
| `input` | object | Tool input parameters (with sensitive data scrubbed) |
| `output` | string | Tool output (truncated to `maxOutputChars`, default 1000) |
| `isError` | boolean | Whether the tool execution resulted in an error |
| `permissionDecision` | `allow` / `deny` / `ask` | The permission system's decision for this invocation |
| `durationMs` | number | Execution duration in milliseconds |
| `agentId` | string | Identifier of the agent that requested the execution |
| `sessionId` | string | Session identifier for correlating related operations |

#### Automatic Sensitive Data Scrubbing

The audit logger automatically redacts values associated with sensitive keys before writing to the log file. The following patterns are scrubbed:

- `api_key`
- `token`
- `password`
- `secret`
- `authorization`

All matching values are replaced with `[REDACTED]`.

**Example scrubbed log entry:**

```json
{
  "timestamp": "2026-04-02T14:30:00.000Z",
  "toolName": "Bash",
  "toolUseId": "tu_abc123",
  "input": {
    "command": "curl -H 'Authorization: [REDACTED]' https://api.example.com/data"
  },
  "output": "{\"status\":\"ok\"}",
  "isError": false,
  "permissionDecision": "allow",
  "durationMs": 342,
  "agentId": "agent-main",
  "sessionId": "2026-04-02T14-30-00-000Z"
}
```

#### Fail-Safe Design

The audit logger is designed to never crash the host agent. If a write fails (disk full, permission error, etc.), the error is silently caught. This ensures that logging failures do not impact agent availability -- an important consideration for SOC 2 Availability criteria.

#### SOC 2 Relevance

- **CC2.1:** Audit logs provide relevant, quality information about system operations.
- **CC7.1 / CC7.2:** Every tool execution is logged, enabling detection of unauthorized or anomalous activity.
- **CC7.3:** JSONL format enables integration with SIEM platforms (Splunk, Datadog, ELK Stack) for automated event evaluation.
- **PI1.3 / PI1.4:** Output capture and error tracking provide evidence of processing completeness and accuracy.
- **C1.1:** Sensitive data scrubbing prevents confidential information from appearing in log files.

#### Compliance Recommendation

For SOC 2 Type II audits, configure centralized log collection and set appropriate retention periods:

```json
{
  "dataDirectory": "/var/nexus/data",
  "audit": {
    "enabled": true,
    "maxOutputChars": 2000
  }
}
```

Integrate with a SIEM by tailing the JSONL file:

```bash
tail -f /var/nexus/data/audit.jsonl | your-siem-forwarder
```

---

### 4. Rate Limiting

**Source:** `src/core/rate-limiter.ts` (256 lines)

The Rate Limiter uses a sliding window algorithm to enforce per-tool and per-agent invocation limits, protecting against runaway agents and denial-of-service conditions.

#### Sliding Window Algorithm

Instead of fixed time buckets, the rate limiter maintains a sliding window of timestamps for each key. Expired entries are pruned on each check, providing smooth rate enforcement without the burst-at-boundary problem of fixed windows.

#### Configuration Structure

```json
{
  "rateLimiting": {
    "enabled": true,
    "rules": [
      {
        "type": "tool",
        "pattern": "Bash",
        "maxCount": 100,
        "windowSeconds": 60
      },
      {
        "type": "tool",
        "pattern": "WriteFile",
        "maxCount": 50,
        "windowSeconds": 60
      },
      {
        "type": "agent",
        "pattern": "agent-*",
        "maxCount": 500,
        "windowSeconds": 300
      }
    ]
  }
}
```

#### Rate Limit Decision

When a tool invocation is rate-limited, the system returns:

| Field | Type | Description |
|---|---|---|
| `allowed` | boolean | Whether the invocation is permitted |
| `currentCount` | number | Current number of invocations in the window |
| `maxCount` | number | Maximum allowed invocations |
| `retryAfterSeconds` | number | Seconds until the oldest entry expires (when denied) |

#### SOC 2 Relevance

- **A1.1:** Rate limiting ensures that processing capacity is managed and protected against overconsumption.
- **CC7.2:** Anomalous invocation patterns (hitting rate limits) can serve as indicators of compromise or misconfigured agents.
- **CC7.4:** Automatic throttling is a form of automated incident response.

---

### 5. Encrypted Memory

**Source:** `src/memory/encryption.ts` (185 lines)

The Encrypted Memory system provides AES-256-GCM encryption for memory entries at rest, ensuring that sensitive data stored by agents is protected against unauthorized access to the underlying storage.

#### Encryption Specification

| Property | Value |
|---|---|
| Algorithm | AES-256-GCM (authenticated encryption) |
| Key Derivation | Hex master key (direct) or scrypt from passphrase |
| IV Length | 16 bytes (randomly generated per encryption) |
| Auth Tag Length | 16 bytes |
| Payload Format | `enc:v1:<base64(iv + authTag + ciphertext)>` |

#### Key Management Options

**Option 1: Hex Master Key** (recommended for production)

```bash
# Generate a 256-bit key
openssl rand -hex 32

# Set via environment variable
export NEXUS_ENCRYPTION_KEY="a1b2c3d4e5f6..."
```

**Option 2: Passphrase** (uses scrypt KDF)

```json
{
  "encryption": {
    "passphrase": "${NEXUS_ENCRYPTION_PASSPHRASE}"
  }
}
```

#### Per-Field Encryption

By default, only the `content` field of memory entries is encrypted. Organizations can configure additional fields:

```json
{
  "encryption": {
    "masterKey": "${NEXUS_ENCRYPTION_KEY}",
    "encryptedFields": ["content", "metadata", "tags"]
  }
}
```

#### Backward Compatibility

The system transparently handles unencrypted data. Entries without the `enc:v1:` prefix are read as plaintext, enabling gradual migration to encrypted storage without data loss.

#### Tamper Detection

AES-256-GCM is an authenticated encryption mode. Any modification to the ciphertext, IV, or auth tag will cause decryption to fail, providing cryptographic tamper detection.

#### SOC 2 Relevance

- **C1.1:** Encryption at rest protects confidential information stored in agent memory.
- **CC6.1:** Cryptographic access control ensures that only entities with the encryption key can read memory contents.
- **CC6.7:** Per-field encryption restricts data exposure even if partial access to the storage layer is compromised.
- **PI1.1:** GCM authentication ensures processing integrity of stored data.

#### Compliance Recommendation

For SOC 2 environments:

1. Use hex master keys (not passphrases) for production deployments
2. Store keys in a secrets manager (AWS Secrets Manager, HashiCorp Vault, etc.)
3. Rotate keys periodically and re-encrypt stored data
4. Encrypt all fields containing sensitive information, not just `content`

---

### 6. Sandboxed Execution

**Source:** `src/tools/sandbox.ts` (252 lines)

The Docker-based sandbox provides process-level isolation for Bash command execution, preventing agents from affecting the host system or other agents.

#### Isolation Capabilities

| Control | Description | Configuration |
|---|---|---|
| **Container Isolation** | Each execution runs in a dedicated Docker container | Automatic container creation and cleanup |
| **Memory Limits** | Restricts container memory allocation | `memoryLimitMb` |
| **CPU Limits** | Restricts container CPU usage | `cpuLimit` (e.g., `"0.5"` for half a core) |
| **Network Control** | Controls container network access | `networkMode`: `none`, `bridge`, or `host` |
| **Read-Only Mounts** | Mount host directories as read-only | `readOnlyMounts` |
| **Read-Write Mounts** | Mount specific host directories as writable | `readWriteMounts` |
| **Timeout Enforcement** | Kills containers that exceed time limits | `timeout` (milliseconds) |
| **Auto-Cleanup** | Removes containers after execution | Automatic on completion or error |

#### Configuration Example

```json
{
  "sandbox": {
    "enabled": true,
    "image": "node:20-alpine",
    "memoryLimitMb": 512,
    "cpuLimit": "1.0",
    "networkMode": "none",
    "readOnlyMounts": [
      { "hostPath": "/app/src", "containerPath": "/workspace/src" }
    ],
    "readWriteMounts": [
      { "hostPath": "/app/output", "containerPath": "/workspace/output" }
    ],
    "timeout": 30000
  }
}
```

#### SOC 2 Relevance

- **CC6.6:** Docker containers enforce system boundaries, preventing agent code from accessing host resources.
- **CC6.7:** Network mode `none` prevents data exfiltration. Read-only mounts prevent unauthorized data modification.
- **A1.1:** Memory and CPU limits protect system availability by preventing resource exhaustion.
- **A1.2:** Auto-cleanup ensures containers do not accumulate and consume resources.

#### Compliance Recommendation

For SOC 2 environments, enforce the strictest sandbox configuration:

```json
{
  "sandbox": {
    "enabled": true,
    "image": "node:20-alpine",
    "memoryLimitMb": 256,
    "cpuLimit": "0.5",
    "networkMode": "none",
    "readOnlyMounts": [
      { "hostPath": "/app/src", "containerPath": "/workspace/src" }
    ],
    "readWriteMounts": [],
    "timeout": 15000
  }
}
```

Key principles:
- Set `networkMode` to `none` unless external access is explicitly required
- Use read-only mounts by default; grant read-write access only to designated output directories
- Set conservative timeout and resource limits

---

### 7. OAuth 2.0 for MCP

**Source:** `src/mcp/oauth.ts` (194 lines)

The OAuth Token Manager provides standards-compliant OAuth 2.0 authentication for MCP (Model Context Protocol) server connections.

#### Supported Grant Types

| Grant Type | Use Case |
|---|---|
| `client_credentials` | Machine-to-machine authentication (recommended for agents) |
| `refresh_token` | Token renewal without re-authentication |

#### Token Lifecycle

1. **Acquisition:** Tokens are fetched from the configured token endpoint using client credentials
2. **Caching:** Active tokens are cached in memory (never persisted to disk)
3. **Auto-Refresh:** Tokens are proactively refreshed before expiration based on a configurable buffer
4. **Revocation:** Tokens can be explicitly revoked when sessions end

#### Configuration Example

```json
{
  "mcpServers": [
    {
      "name": "secure-tools",
      "transport": "http",
      "url": "https://mcp.internal.example.com",
      "oauth": {
        "tokenUrl": "https://auth.example.com/oauth/token",
        "clientId": "${MCP_CLIENT_ID}",
        "clientSecret": "${MCP_CLIENT_SECRET}",
        "scope": "tools:read tools:execute",
        "refreshBufferSeconds": 120
      }
    }
  ]
}
```

#### SOC 2 Relevance

- **CC6.2:** OAuth 2.0 provides industry-standard credential management for machine-to-machine authentication.
- **CC6.1:** Token-based access control with automatic expiration limits the window of credential compromise.
- **C1.1:** Tokens are cached in memory only, never written to persistent storage.

#### Compliance Recommendation

- Use `client_credentials` grant for all agent-to-MCP-server connections
- Set `refreshBufferSeconds` to at least 60 seconds to prevent token expiration gaps
- Store `clientId` and `clientSecret` in environment variables, never in config files
- Implement token revocation on session termination

---

### 8. Web Server Authentication

**Source:** `src/web/server.ts`

The Nexus Web Server provides HTTP and WebSocket endpoints with authentication and session management.

#### Security Features

| Feature | Description |
|---|---|
| **Bearer Token Auth** | All HTTP requests require a valid `Authorization: Bearer <token>` header |
| **CORS Control** | Cross-Origin Resource Sharing is disabled by default; opt-in for development |
| **Default Bind Address** | Server binds to `127.0.0.1` by default (loopback only) |
| **Session Management** | Each WebSocket connection receives a unique session ID |

#### Configuration Example

```json
{
  "web": {
    "port": 3000,
    "host": "127.0.0.1",
    "cors": false,
    "authToken": "${NEXUS_WEB_AUTH_TOKEN}"
  }
}
```

#### SOC 2 Relevance

- **CC6.1 / CC6.2:** Bearer token authentication controls access to the web interface.
- **CC6.6:** Default loopback binding restricts access to the local machine.
- **CC6.7:** Disabled CORS prevents unauthorized cross-origin requests.

#### Compliance Recommendation

- Always set `authToken` via environment variable
- Never enable CORS in production
- Use a reverse proxy (nginx, Caddy) with TLS termination in front of the Nexus web server
- Bind to `127.0.0.1` when behind a reverse proxy; use firewall rules if binding to `0.0.0.0`

---

### 9. Docker Deployment

**Source:** `Dockerfile`

The Nexus Dockerfile follows container security best practices for production deployments.

#### Security Features

| Feature | Implementation |
|---|---|
| **Multi-Stage Build** | Build dependencies are excluded from the runtime image |
| **Minimal Base Image** | `node:20-alpine` reduces the attack surface |
| **Non-Root User** | Runtime executes as the `nexus` user (`addgroup -S nexus && adduser -S nexus -G nexus`) |
| **Production Dependencies** | `npm ci --omit=dev` excludes development packages |
| **Dedicated Data Directory** | `/data` directory owned by the `nexus` user |

#### SOC 2 Relevance

- **CC6.6:** Multi-stage builds and minimal base images reduce the attack surface.
- **CC6.8:** Non-root execution prevents privilege escalation within the container.
- **CC5.2:** Production-only dependencies minimize the inclusion of unnecessary code.

#### Compliance Recommendation

Extend the Dockerfile for SOC 2 deployments:

```dockerfile
FROM node:20-alpine

# ... (standard Nexus Dockerfile steps)

# Additional hardening
RUN apk --no-cache add dumb-init
RUN chmod -R 555 /app/dist

USER nexus

HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

ENTRYPOINT ["dumb-init", "node", "dist/cli/index.js"]
```

---

### 10. Hub Security Review

The Nexus Hub categorizes published extensions, tools, and skills with a security review status:

| Status | Meaning | SOC 2 Implication |
|---|---|---|
| **Verified** | Reviewed and approved by the Nexus maintainers | Suitable for SOC 2 environments |
| **Community** | Published by community members, not formally reviewed | Requires internal review before deployment |
| **Unreviewed** | No review performed | Not recommended for SOC 2 environments |

#### Compliance Recommendation

- Only deploy extensions with `verified` status in SOC 2-regulated environments
- Maintain an internal allowlist of approved Hub extensions
- Review `community` extensions internally before deployment
- Document the review process for auditors

---

### 11. Configuration Management

Nexus implements a 5-layer configuration precedence system with validation at every layer.

#### Configuration Precedence (lowest to highest)

| Priority | Source | Description |
|---|---|---|
| 1 | Built-in defaults | Hardcoded safe defaults |
| 2 | User config | `~/.nexus/config.json` (user-level settings) |
| 3 | Project config | `.nexus/config.json` (project-level settings) |
| 4 | Environment variables | `NEXUS_*` prefixed variables |
| 5 | CLI flags | Command-line arguments |

#### Security-Relevant Defaults

| Setting | Default Value | Security Implication |
|---|---|---|
| `permissionMode` | `"default"` (prompt) | No tool runs without user approval |
| `maxConcurrentTools` | `4` | Limits parallel execution |
| `web.host` | `"127.0.0.1"` | Loopback-only binding |
| `web.cors` | `false` | Cross-origin requests blocked |

#### API Keys from Environment Only

Nexus enforces that API keys and secrets are provided via environment variables, never embedded in configuration files. This prevents accidental exposure through version control or file system access.

```bash
# Correct: API keys via environment
export ANTHROPIC_API_KEY="sk-ant-..."
export NEXUS_ENCRYPTION_KEY="a1b2c3d4..."
export NEXUS_WEB_AUTH_TOKEN="..."
```

#### Zod Schema Validation

All configuration is validated against a Zod schema at load time. Invalid configurations are rejected with descriptive error messages, preventing misconfigured deployments.

#### SOC 2 Relevance

- **CC8.1:** Configuration changes follow a defined precedence with validation, ensuring authorized and valid changes.
- **PI1.2:** Zod validation ensures configuration inputs are complete, valid, and accurate.
- **C1.1:** Environment-only secrets prevent credential leakage.

---

### 12. Self-Host Safety

When Nexus operates in self-development mode (developing itself), additional safety controls are activated.

#### Safe/Denied Command Lists

| List | Purpose | Examples |
|---|---|---|
| **Safe Commands** | Commands explicitly allowed in self-host mode | `git`, `npm test`, `npm run build`, `npm run typecheck` |
| **Denied Commands** | Commands explicitly blocked in self-host mode | `rm -rf /`, `sudo`, `curl \| sh`, direct network access |

#### SOC 2 Relevance

- **CC6.8:** Denied command lists prevent execution of unauthorized or dangerous software.
- **CC5.1:** Safe command lists define explicit control activities for self-development scenarios.

---

## Deployment Checklist for SOC 2-Ready Setup

Use this checklist when preparing a Nexus deployment for SOC 2 compliance.

### Access Control

- [ ] Set `permissionMode` to `"denyAll"` and explicitly allow only required tools
- [ ] Configure RBAC with `defaultRole` set to `"viewer"`
- [ ] Define custom roles for each agent type with least-privilege permissions
- [ ] Assign agents to roles using specific patterns (avoid wildcard-only assignments)
- [ ] Set `authToken` for web server access via environment variable
- [ ] Configure OAuth 2.0 for all MCP server connections

### Encryption

- [ ] Enable memory encryption with a 256-bit hex master key
- [ ] Store the encryption key in a secrets manager (not in config files or environment)
- [ ] Configure `encryptedFields` to cover all sensitive data fields
- [ ] Verify encryption is working by inspecting stored memory entries for `enc:v1:` prefix

### Audit and Monitoring

- [ ] Verify audit logging is enabled (default: `true`)
- [ ] Configure SIEM integration for `audit.jsonl` forwarding
- [ ] Set up alerting for: permission denials, rate limit hits, error spikes
- [ ] Establish log retention policy (recommended: 12 months minimum for SOC 2 Type II)
- [ ] Protect audit log files with appropriate filesystem permissions

### Sandboxing

- [ ] Enable Docker sandbox for all Bash tool executions
- [ ] Set `networkMode` to `"none"` unless external access is required
- [ ] Configure memory and CPU limits appropriate for workload
- [ ] Use read-only mounts for source code and input data
- [ ] Set timeout values to prevent runaway executions

### Network and Infrastructure

- [ ] Deploy behind a reverse proxy with TLS termination
- [ ] Bind web server to `127.0.0.1` when behind a reverse proxy
- [ ] Disable CORS (`cors: false`)
- [ ] Run the Docker container as a non-root user (default in Nexus Dockerfile)
- [ ] Use multi-stage Docker builds to minimize image attack surface

### Configuration Security

- [ ] Store all API keys and secrets in environment variables
- [ ] Enable Zod configuration validation (enabled by default)
- [ ] Use project-level config for project-specific rules
- [ ] Document all permission rules and RBAC assignments
- [ ] Review configuration changes through a change management process

### Rate Limiting

- [ ] Enable rate limiting for all production deployments
- [ ] Configure per-tool limits based on expected usage patterns
- [ ] Configure per-agent limits for multi-agent deployments
- [ ] Monitor rate limit hits as potential security indicators

### Hub Security

- [ ] Use only `verified` extensions from the Nexus Hub
- [ ] Maintain an internal allowlist of approved extensions
- [ ] Document the internal review process for `community` extensions
- [ ] Block `unreviewed` extensions in production

---

## Monitoring and Incident Response

### Continuous Monitoring

#### Key Metrics to Track

| Metric | Source | Alert Threshold |
|---|---|---|
| Permission denials per hour | Audit log (`permissionDecision: "deny"`) | > 10 denials/hour |
| Rate limit hits per hour | Rate limiter decisions | > 5 hits/hour |
| Tool execution errors | Audit log (`isError: true`) | > 5% error rate |
| Average tool execution time | Audit log (`durationMs`) | > 2x baseline |
| Unique agent IDs per session | Audit log (`agentId`) | Unexpected new agents |
| Sandbox timeout events | Sandbox execution results | Any occurrence |

#### SIEM Integration

Nexus audit logs are in JSONL format, compatible with all major SIEM platforms:

**Splunk:**
```
# inputs.conf
[monitor:///var/nexus/data/audit.jsonl]
sourcetype = nexus:audit
index = security
```

**Datadog:**
```yaml
# conf.d/nexus.yaml
logs:
  - type: file
    path: /var/nexus/data/audit.jsonl
    service: nexus
    source: nexus-audit
```

**Filebeat (ELK Stack):**
```yaml
filebeat.inputs:
  - type: log
    paths:
      - /var/nexus/data/audit.jsonl
    json.keys_under_root: true
    json.add_error_key: true
```

### Incident Response Procedures

#### 1. Unauthorized Tool Access Detected

**Indicators:** Unexpected `permissionDecision: "deny"` entries in audit log

**Response:**
1. Identify the agent ID and session ID from the audit log
2. Review the full session history by filtering audit logs on the session ID
3. Determine if the access attempt was legitimate (misconfiguration) or malicious
4. If malicious: terminate the session, revoke any associated OAuth tokens, rotate credentials
5. Update permission rules to prevent recurrence
6. Document the incident

#### 2. Rate Limit Exhaustion

**Indicators:** Sustained rate limit hits from a single agent or tool

**Response:**
1. Identify the rate-limited agent/tool from rate limiter decisions
2. Evaluate whether the rate limit is too restrictive or the agent is misbehaving
3. If misbehaving: terminate the agent session
4. Review agent configuration for infinite loops or recursive behavior
5. Adjust rate limits if they are too restrictive for legitimate workloads

#### 3. Sandbox Escape Attempt

**Indicators:** Sandbox timeout, unusual network activity from containers, container escape errors

**Response:**
1. Immediately terminate all active sandbox containers
2. Review the commands that triggered the sandbox execution
3. Analyze container logs for evidence of escape techniques
4. Update sandbox configuration (reduce permissions, disable network)
5. Review and update the permission rules for the affected tool
6. Escalate to the security team

#### 4. Encryption Key Compromise

**Indicators:** Unauthorized access to key management system, suspicious memory access patterns

**Response:**
1. Generate a new encryption key immediately
2. Re-encrypt all memory entries with the new key
3. Revoke the compromised key in the secrets manager
4. Audit all memory access during the potential exposure window
5. Assess data exposure and notify affected parties if required

---

## Appendix: Sample Configurations

### A. Minimal SOC 2 Configuration

The following configuration represents the minimum security posture for a SOC 2-compliant Nexus deployment:

```json
{
  "defaultModel": "claude-sonnet-4-6",
  "defaultProvider": "anthropic",
  "permissionMode": "denyAll",
  "permissionRules": [
    { "toolName": "Read", "behavior": "allow", "source": "project" },
    { "toolName": "Grep", "behavior": "allow", "source": "project" },
    { "toolName": "Glob", "behavior": "allow", "source": "project" }
  ],
  "maxConcurrentTools": 2,
  "dataDirectory": "/var/nexus/data"
}
```

Environment variables:
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export NEXUS_ENCRYPTION_KEY="$(openssl rand -hex 32)"
export NEXUS_WEB_AUTH_TOKEN="$(openssl rand -hex 32)"
```

### B. Full SOC 2 Production Configuration

```json
{
  "defaultModel": "claude-sonnet-4-6",
  "defaultProvider": "anthropic",
  "workingDirectory": "/app/workspace",
  "dataDirectory": "/var/nexus/data",
  "permissionMode": "denyAll",
  "maxConcurrentTools": 4,
  "permissionRules": [
    { "toolName": "Read", "behavior": "allow", "source": "user" },
    { "toolName": "Grep", "behavior": "allow", "source": "user" },
    { "toolName": "Glob", "behavior": "allow", "source": "user" },
    { "toolName": "WebFetch", "behavior": "allow", "source": "user" },
    { "toolName": "Bash", "pattern": "git log *", "behavior": "allow", "source": "project" },
    { "toolName": "Bash", "pattern": "git diff *", "behavior": "allow", "source": "project" },
    { "toolName": "Bash", "pattern": "git status", "behavior": "allow", "source": "project" },
    { "toolName": "Bash", "pattern": "npm test", "behavior": "allow", "source": "project" },
    { "toolName": "Bash", "pattern": "npm run build", "behavior": "allow", "source": "project" },
    { "toolName": "Bash", "pattern": "rm -rf *", "behavior": "deny", "source": "user" },
    { "toolName": "Bash", "pattern": "sudo *", "behavior": "deny", "source": "user" },
    { "toolName": "Bash", "pattern": "curl * | *sh", "behavior": "deny", "source": "user" },
    { "toolName": "Bash", "pattern": "> /dev/*", "behavior": "deny", "source": "user" }
  ],
  "rbac": {
    "roles": [
      {
        "name": "production-agent",
        "description": "Standard production agent with controlled access",
        "inherits": ["developer"],
        "permissions": [
          { "toolName": "Bash", "pattern": "docker *", "behavior": "deny", "source": "project" },
          { "toolName": "Bash", "pattern": "curl *", "behavior": "deny", "source": "project" }
        ]
      },
      {
        "name": "ci-runner",
        "description": "CI/CD pipeline agent",
        "inherits": ["developer"],
        "permissions": [
          { "toolName": "Bash", "pattern": "npm test", "behavior": "allow", "source": "project" },
          { "toolName": "Bash", "pattern": "npm run build", "behavior": "allow", "source": "project" },
          { "toolName": "Bash", "pattern": "npm run typecheck", "behavior": "allow", "source": "project" }
        ]
      },
      {
        "name": "readonly-analyst",
        "description": "Read-only agent for analysis and reporting",
        "inherits": ["viewer"],
        "permissions": []
      }
    ],
    "assignments": [
      { "agentId": "prod-*", "role": "production-agent" },
      { "agentId": "ci-*", "role": "ci-runner" },
      { "agentId": "analyst-*", "role": "readonly-analyst" },
      { "agentId": "*", "role": "viewer" }
    ],
    "defaultRole": "viewer"
  },
  "rateLimiting": {
    "enabled": true,
    "rules": [
      { "type": "tool", "pattern": "Bash", "maxCount": 60, "windowSeconds": 60 },
      { "type": "tool", "pattern": "WriteFile", "maxCount": 30, "windowSeconds": 60 },
      { "type": "tool", "pattern": "EditFile", "maxCount": 30, "windowSeconds": 60 },
      { "type": "tool", "pattern": "WebFetch", "maxCount": 20, "windowSeconds": 60 },
      { "type": "agent", "pattern": "*", "maxCount": 200, "windowSeconds": 300 }
    ]
  },
  "sandbox": {
    "enabled": true,
    "image": "node:20-alpine",
    "memoryLimitMb": 512,
    "cpuLimit": "1.0",
    "networkMode": "none",
    "readOnlyMounts": [
      { "hostPath": "/app/src", "containerPath": "/workspace/src" }
    ],
    "readWriteMounts": [
      { "hostPath": "/app/output", "containerPath": "/workspace/output" }
    ],
    "timeout": 30000
  },
  "encryption": {
    "masterKey": "${NEXUS_ENCRYPTION_KEY}",
    "encryptedFields": ["content", "metadata"]
  },
  "web": {
    "port": 3000,
    "host": "127.0.0.1",
    "cors": false,
    "authToken": "${NEXUS_WEB_AUTH_TOKEN}"
  },
  "mcpServers": [
    {
      "name": "internal-tools",
      "transport": "http",
      "url": "https://mcp.internal.example.com",
      "oauth": {
        "tokenUrl": "https://auth.example.com/oauth/token",
        "clientId": "${MCP_CLIENT_ID}",
        "clientSecret": "${MCP_CLIENT_SECRET}",
        "scope": "tools:read tools:execute",
        "refreshBufferSeconds": 120
      }
    }
  ]
}
```

### C. Docker Compose for SOC 2 Deployment

```yaml
version: "3.8"

services:
  nexus:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    user: "nexus"
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    environment:
      - NODE_ENV=production
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - NEXUS_ENCRYPTION_KEY=${NEXUS_ENCRYPTION_KEY}
      - NEXUS_WEB_AUTH_TOKEN=${NEXUS_WEB_AUTH_TOKEN}
    volumes:
      - nexus-data:/data
      - ./workspace:/app/workspace:ro
    ports:
      - "127.0.0.1:3000:3000"
    deploy:
      resources:
        limits:
          cpus: "2.0"
          memory: 1G
        reservations:
          cpus: "0.5"
          memory: 256M
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "5"

volumes:
  nexus-data:
    driver: local
```

### D. Audit Log Analysis Queries

**Find all permission denials in the last 24 hours:**
```bash
jq 'select(.permissionDecision == "deny") | {timestamp, toolName, agentId, input}' \
  /var/nexus/data/audit.jsonl | \
  jq 'select(.timestamp > "'$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%S)'Z")'
```

**Count tool invocations by agent:**
```bash
jq -r '.agentId' /var/nexus/data/audit.jsonl | sort | uniq -c | sort -rn
```

**Find all errors in a specific session:**
```bash
jq 'select(.sessionId == "SESSION_ID" and .isError == true)' /var/nexus/data/audit.jsonl
```

**Calculate average execution time per tool:**
```bash
jq -r '[.toolName, .durationMs] | @tsv' /var/nexus/data/audit.jsonl | \
  awk '{sum[$1]+=$2; count[$1]++} END {for (t in sum) print t, sum[t]/count[t] "ms"}'
```

---

*This document is intended for internal use by compliance officers, security engineers, and DevOps teams deploying the Nexus Agent Framework in SOC 2-regulated environments. It should be reviewed and updated alongside each major Nexus release.*
