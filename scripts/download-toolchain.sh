#!/usr/bin/env bash
# Install the local toolchain. Skip tools that are already installed.
# Does not clone repositories and does not start any service.
set -euo pipefail

if [[ -f "${HOME}/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "${HOME}/.cargo/env"
fi
if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "${HOME}/.nvm/nvm.sh"
fi
export PATH="${HOME}/.foundry/bin:${HOME}/.cargo/bin:${PATH}"

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

apt_install() {
  if ! has_cmd apt-get; then
    echo "missing packages: $* (apt-get not available)" >&2
    exit 1
  fi
  if ! has_cmd sudo; then
    echo "missing packages: $* (sudo not available)" >&2
    exit 1
  fi
  sudo apt-get update
  sudo apt-get install -y "$@"
}

need_apt=()
has_cmd git || need_apt+=(git)
has_cmd curl || need_apt+=(curl)
has_cmd python3 || need_apt+=(python3)
has_cmd gcc || need_apt+=(build-essential)
has_cmd pkg-config || need_apt+=(pkg-config)
if ! pkg-config --exists libssl 2>/dev/null; then
  need_apt+=(libssl-dev pkg-config)
fi
if [[ ${#need_apt[@]} -gt 0 ]]; then
  # de-duplicate
  declare -A seen=()
  unique=()
  for pkg in "${need_apt[@]}"; do
    [[ -n "${seen[$pkg]:-}" ]] && continue
    seen[$pkg]=1
    unique+=("$pkg")
  done
  echo "install ${unique[*]}"
  apt_install "${unique[@]}"
else
  echo "skip  apt packages"
fi

if has_cmd rustup && has_cmd cargo && has_cmd rustc; then
  echo "skip  rust"
else
  echo "install rust"
  curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  # shellcheck disable=SC1091
  source "${HOME}/.cargo/env"
fi
rustup default stable

if has_cmd node && has_cmd npm; then
  echo "skip  node"
else
  echo "install node"
  if [[ ! -s "${HOME}/.nvm/nvm.sh" ]]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  fi
  # shellcheck disable=SC1091
  source "${HOME}/.nvm/nvm.sh"
  nvm install --lts
fi

if has_cmd forge && has_cmd cast; then
  echo "skip  foundry"
else
  echo "install foundry"
  curl -fsSL https://foundry.paradigm.xyz | bash
  export PATH="${HOME}/.foundry/bin:${PATH}"
  foundryup
fi

echo "rustc $(rustc --version)"
echo "cargo $(cargo --version)"
echo "node $(node --version)"
echo "npm $(npm --version)"
echo "forge $(forge --version)"
echo "python3 $(python3 --version)"
echo "git $(git --version)"
echo "curl $(curl --version | head -n 1)"
echo "ready"
echo "If a new shell cannot find cargo, forge, or node, open a new terminal or run:"
echo "  source \"\$HOME/.cargo/env\""
echo "  export PATH=\"\$HOME/.foundry/bin:\$PATH\""
echo "  source \"\$HOME/.nvm/nvm.sh\""
