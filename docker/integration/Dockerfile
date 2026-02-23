FROM rust:1-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tmux \
        ca-certificates \
        pkg-config \
        libssl-dev \
        git \
        nodejs \
        npm \
        bash \
    && npm install --global @openai/codex \
    && codex --version \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

ENV CARGO_TERM_COLOR=always
