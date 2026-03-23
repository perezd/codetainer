FROM debian:bookworm-slim

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl dnsutils fd-find git iptables sudo \
    jq less python3 ripgrep tmux tree unzip wget xxd \
    && rm -rf /var/lib/apt/lists/*

# just (not in Debian repos — install from official prebuilt binary)
RUN curl -fsSL https://just.systems/install.sh | bash -s -- --to /usr/local/bin

# gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# CoreDNS
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/coredns/coredns/releases/download/v1.12.1/coredns_1.12.1_linux_${ARCH}.tgz" \
    | tar -xz -C /usr/local/bin/ \
    && chmod +x /usr/local/bin/coredns

# Create claude user before installing user-level tools
RUN useradd -m -s /bin/bash -u 1000 claude

# Bun (install as claude user)
USER claude
RUN curl -fsSL https://bun.sh/install | bash
USER root
RUN ln -s /home/claude/.bun/bin/bun /usr/local/bin/bun \
    && ln -s /home/claude/.bun/bin/bunx /usr/local/bin/bunx

# Claude Code (install as claude user)
USER claude
RUN curl -fsSL https://claude.ai/install.sh | bash
USER root
RUN ln -s /home/claude/.local/bin/claude /usr/local/bin/claude

# Start-claude script: handles auth, tmux creation, and attach
COPY start-claude /usr/local/bin/start-claude
RUN chmod +x /usr/local/bin/start-claude

# Auto-attach to existing tmux session on SSH login (if it exists)
RUN echo 'export TERM=xterm-256color; if tmux -S /tmp/tmux-1000/default has-session -t claude 2>/dev/null; then exec tmux -S /tmp/tmux-1000/default attach -t claude; fi' \
    >> /root/.bashrc

# Approval system
COPY approval/ /opt/approval/
RUN chmod +x /opt/approval/*.sh /opt/approval/approve
RUN cp /opt/approval/approve /usr/local/bin/approve

# Network config
COPY network/ /opt/network/
RUN chmod +x /opt/network/refresh-iptables.sh

# Claude settings template
COPY claude-settings.json /opt/claude/settings.json

# Status tool
COPY status /usr/local/bin/status
RUN chmod +x /usr/local/bin/status

# Entrypoint
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Writable mount targets
RUN mkdir -p /workspace /home/claude/.cache /home/claude/.claude

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
