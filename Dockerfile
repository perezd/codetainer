FROM debian:bookworm-slim

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl dnsutils fd-find git iptables sudo \
    jq less locales python3 ripgrep tree unzip wget xxd \
    && rm -rf /var/lib/apt/lists/*

# Generate UTF-8 locale (bookworm-slim strips locale data; needed for TUI rendering)
RUN sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# tmux 3.6+ (synchronized output support for Claude Code TUI)
# bookworm ships 3.3a which causes rendering flicker
RUN apt-get update && apt-get install -y --no-install-recommends \
    libevent-dev libncurses-dev bison pkg-config make gcc \
    && TMUX_VERSION=3.6a \
    && curl -fsSL "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz" \
    | tar -xz \
    && cd "tmux-${TMUX_VERSION}" \
    && ./configure --prefix=/usr/local \
    && make -j"$(nproc)" \
    && make install \
    && cd / && rm -rf "tmux-${TMUX_VERSION}" \
    && apt-get purge -y libevent-dev libncurses-dev bison pkg-config make gcc \
    && apt-get autoremove -y \
    && apt-get install -y --no-install-recommends libevent-core-2.1-7 libncurses6 \
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
# Copy bun binaries to shared location (not symlinks — /home/claude is tmpfs at runtime)
RUN cp -L /home/claude/.bun/bin/bun /usr/local/bin/bun \
    && cp -L /home/claude/.bun/bin/bunx /usr/local/bin/bunx

# Claude Code (install as claude user)
USER claude
RUN curl -fsSL https://claude.ai/install.sh | bash
USER root
# Copy claude binary to shared location and configure install method
RUN cp -L /home/claude/.local/bin/claude /usr/local/bin/claude
USER claude
RUN claude install 2>/dev/null || true
USER root

# Pre-clone superpowers plugin at build time (public repo, no auth needed)
RUN git clone --depth 1 https://github.com/obra/superpowers.git \
       /opt/claude-plugins/superpowers

# Start-claude script: handles auth, tmux creation, and attach
COPY start-claude /usr/local/bin/start-claude
RUN chmod +x /usr/local/bin/start-claude

# Run start-claude on SSH login (handles auth + tmux attach/create)
RUN echo 'export TERM=xterm-256color; exec /usr/local/bin/start-claude' >> /root/.bashrc

# Approval system
COPY approval/ /opt/approval/
RUN chmod +x /opt/approval/*.sh /opt/approval/approve
RUN cp /opt/approval/approve /usr/local/bin/approve

# gh wrapper (ensures GH_CONFIG_DIR is always set for Claude Code subprocesses)
COPY gh-wrapper.sh /usr/local/bin/gh
RUN chmod +x /usr/local/bin/gh

# Network config
COPY network/ /opt/network/
RUN chmod +x /opt/network/refresh-iptables.sh

# Claude settings template, statusline, and session namer
COPY claude-settings.json /opt/claude/settings.json
COPY statusline-command.sh /opt/claude/statusline-command.sh
COPY session-namer.sh /opt/claude/session-namer.sh
RUN chmod +x /opt/claude/statusline-command.sh /opt/claude/session-namer.sh

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
