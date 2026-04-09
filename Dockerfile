FROM debian:bookworm-slim

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash bat ca-certificates curl dnsutils fd-find git iptables sudo \
    jq less locales python3 ripgrep tree unzip wget xxd \
    && ln -s /usr/bin/batcat /usr/local/bin/bat \
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

# glow (Markdown renderer — not in Debian repos)
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSLo /tmp/glow.deb "https://github.com/charmbracelet/glow/releases/download/v2.1.1/glow_2.1.1_${ARCH}.deb" \
    && dpkg -i /tmp/glow.deb \
    && rm /tmp/glow.deb

# Go 1.26.2 (with checksum verification)
RUN ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "amd64" ]; then \
         GO_SHA256="990e6b4bbba816dc3ee129eaeaf4b42f17c2800b88a2166c265ac1a200262282"; \
       elif [ "$ARCH" = "arm64" ]; then \
         GO_SHA256="c958a1fe1b361391db163a485e21f5f228142d6f8b584f6bef89b26f66dc5b23"; \
       else echo "Unsupported arch: $ARCH" >&2; exit 1; fi \
    && curl -fsSL "https://go.dev/dl/go1.26.2.linux-${ARCH}.tar.gz" -o /tmp/go.tar.gz \
    && echo "${GO_SHA256}  /tmp/go.tar.gz" | sha256sum --check \
    && tar -xz -C /usr/local < /tmp/go.tar.gz \
    && rm /tmp/go.tar.gz

ENV GOPATH="/home/claude/go"
ENV GOTELEMETRY="off"
ENV GOPROXY="https://proxy.golang.org,off"
ENV GONOSUMDB=""
ENV GOFLAGS=""
ENV PATH="${PATH}:/usr/local/go/bin:/home/claude/go/bin"

# gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Fly CLI
RUN curl -fsSL https://fly.io/install.sh | sh \
    && cp -L /root/.fly/bin/flyctl /usr/local/bin/fly \
    && chmod 755 /usr/local/bin/fly

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

# Node.js LTS (required by TypeScript LSP plugin)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g typescript typescript-language-server

# gopls v0.21.1 (Go language server — pinned version, requires Go 1.25+)
RUN GOBIN=/usr/local/go/bin GOPATH=/tmp/gobuild GOCACHE=/tmp/gobuild/cache go install golang.org/x/tools/gopls@v0.21.1 \
    && rm -rf /tmp/gobuild

# Cache-bust: everything below fetches "latest" and must be fresh each build.
# Pass --build-arg CACHE_BUST=$(date +%s) locally, or use github.run_id in CI.
ARG CACHE_BUST=0

# Claude Code (install as claude user)
USER claude
RUN curl -fsSL https://claude.ai/install.sh | bash
USER root
# Copy claude binary to shared location and configure install method
RUN cp -L /home/claude/.local/bin/claude /usr/local/bin/claude
USER claude
RUN claude install 2>/dev/null || true
USER root

# Start-claude script: init-only, called by entrypoint at boot
COPY scripts/start-claude.sh /usr/local/bin/start-claude
RUN chmod +x /usr/local/bin/start-claude

# Attach-claude script: SSH gate-then-attach, waits for init via flock
COPY scripts/attach-claude.sh /usr/local/bin/attach-claude
RUN chmod +x /usr/local/bin/attach-claude

# Run attach-claude on SSH login (waits for init, then attaches to tmux)
RUN echo 'exec /usr/local/bin/attach-claude' >> /root/.bashrc

# gh wrapper (ensures GH_CONFIG_DIR is always set for Claude Code subprocesses)
COPY scripts/gh-wrapper.sh /usr/local/bin/gh
RUN chmod +x /usr/local/bin/gh

# Network config
COPY network/ /opt/network/
COPY scripts/refresh-iptables.sh /opt/network/refresh-iptables.sh
RUN chmod +x /opt/network/refresh-iptables.sh

# Claude settings template, statusline, and session namer
COPY claude-settings.json /opt/claude/settings.json
COPY scripts/statusline-command.sh /opt/claude/statusline-command.sh
COPY scripts/session-namer.sh /opt/claude/session-namer.sh
COPY scripts/sync-fork.sh /opt/claude/sync-fork.sh
RUN chmod +x /opt/claude/statusline-command.sh /opt/claude/session-namer.sh /opt/claude/sync-fork.sh

# Status tool
COPY scripts/status.sh /usr/local/bin/status
RUN chmod +x /usr/local/bin/status

# Entrypoint
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Writable mount targets
RUN mkdir -p /workspace /home/claude/.cache /home/claude/.claude

WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
