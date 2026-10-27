# A fresh Ubuntu server, set up as "Before you install" in the README says, with
# systemd running, for the end-to-end test. A git user and sshd stand in for GitHub.
FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus openssh-server openssh-client git ca-certificates curl xz-utils \
    iproute2 unattended-upgrades caddy sudo tar \
 && rm -rf /var/lib/apt/lists/*

# Node 26, from nodejs.org, as the getting-started guide installs it.
RUN arch="$(dpkg --print-architecture)"; case "$arch" in amd64) arch=x64;; esac; \
    version="$(curl -fsSL https://nodejs.org/dist/latest-v26.x/SHASUMS256.txt | grep -o "node-v26[^ ]*-linux-$arch.tar.xz" | head -1)"; \
    curl -fsSL "https://nodejs.org/dist/latest-v26.x/$version" | tar -xJ -C /usr/local --strip-components=1

# SSH by key only, no root sign-in; automatic updates on.
RUN printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/10-safe.conf \
 && printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades \
 && systemctl enable ssh caddy

# Caddy issues its own certificates here, rather than asking Let's Encrypt for example.org's.
RUN printf '{\n\tlocal_certs\n}\n' > /etc/caddy/Caddyfile

# The stand-in for GitHub: a git user whose repositories are reached as git@github.com:owner/name.git.
RUN useradd --create-home --shell /usr/bin/git-shell git

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
