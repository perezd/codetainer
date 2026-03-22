FROM debian:bookworm-slim

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl dnsutils fd-find git iptables ip6tables \
    jq just less python3 ripgrep tmux tree wget xxd \
    && rm -rf /var/lib/apt/lists/*

# Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Claude Code
RUN curl -fsSL https://claude.ai/install.sh | bash

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

# Create claude user
RUN useradd -m -s /bin/bash -u 1000 claude

# Auto-attach to tmux on SSH login
RUN echo 'if [ -n "$SSH_CONNECTION" ] && tmux has-session -t claude 2>/dev/null; then exec tmux attach -t claude; fi' \
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
