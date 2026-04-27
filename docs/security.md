# Security

Codetainer enforces a three-layer security model. This document covers each layer in detail.

## Layer 1: Container Hardening

- **Non-root execution**: Claude Code runs as user `claude` (UID 1000), not root
- **Read-only root filesystem**: After setup, the root filesystem is remounted read-only (`mount -o remount,ro /`)
- **tmpfs mounts**: Writable areas are memory-backed and size-limited:
  - `/workspace` (512MB) — working directory for code
  - `/home/claude` (1GB) — Claude's home directory
  - `/tmp` (512MB) — temporary files
- **Settings file**: Claude Code's `settings.json` is owned by the `claude` user for normal operation.

## Layer 2: Network Isolation

- **Default-deny outbound**: iptables OUTPUT policy is DROP
- **Domain allowlist**: Only traffic to resolved IPs from `network/domains.conf` is permitted
- **DNS filtering**: CoreDNS returns NXDOMAIN for any domain not in the allowlist, preventing DNS-based data exfiltration
- **IPv4 only**: AAAA queries return empty (NOERROR) to force IPv4, where iptables rules apply
- **Metadata blocked**: Cloud instance metadata (169.254.0.0/16) and Fly private networking (172.16.0.0/12) are explicitly dropped
- **UDP dropped**: All outbound UDP except DNS is dropped (prevents QUIC bypass of TCP-level controls)
- **5-minute refresh**: iptables rules are refreshed every 5 minutes to pick up IP changes
- **IPv6 unrestricted**: Fly SSH requires public IPv6 routing, and Fly's kernel has broken IPv6 conntrack, so IPv6 output is left at ACCEPT. IPv4 iptables is the enforcement layer.

## Layer 3: Command Control

[Stargate](https://github.com/limbic-systems/stargate) classifies every Bash command before execution via Claude Code hooks:

- **AST-based classification**: Commands are parsed into an AST and evaluated against configurable rules (RED/GREEN/YELLOW)
- **Fail-closed**: If the Stargate server is unreachable, all Bash commands are blocked
- **Scope-bound trust**: GitHub CLI operations and HTTP requests are evaluated against operator-defined scopes (`github_owners` derived from `REPO_URL`, `allowed_domains` derived from `network/domains.conf`)
- **LLM review**: Ambiguous (YELLOW) commands are escalated to an LLM reviewer for semantic classification
- **Immutable config**: The Stargate config (`stargate/stargate.toml`) is a static template shipped in the image, copied to the read-only rootfs at boot
- **De-privileged**: The Stargate server runs as the `claude` user, not root

See `stargate/stargate.toml` for the full rule set.

## Domain Allowlist

Edit `network/domains.conf` to add or remove allowed domains. One domain per line, `#` comments supported. Rebuild and redeploy the container.

See [Architecture](architecture.md) for how CoreDNS and iptables consume the allowlist at boot.

## Troubleshooting

Use the `status` command inside the container to check recent iptables drops and CoreDNS status:

```bash
# Show recent iptables drops, CoreDNS status
status
```
