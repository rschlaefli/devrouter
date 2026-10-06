#!/usr/bin/env bash
# Read-only detection of the tools devrouter needs. Prints one table row per
# item: NAME, STATE (ok|missing|info), DETAIL. Changes nothing on the machine.
# Usage: detect.sh [repository-path]
set -u
repo="${1:-.}"

row() { printf '%-18s %-8s %s\n' "$1" "$2" "$3"; }
have() { command -v "$1" >/dev/null 2>&1; }
first_line() { "$@" 2>&1 | head -n 1; }

printf '%-18s %-8s %s\n' ITEM STATE DETAIL

os="$(uname -s)"
case "$os" in
  Darwin) row os info "macOS $(sw_vers -productVersion 2>/dev/null)" ;;
  Linux)
    distro="$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-Linux}")"
    row os info "${distro:-Linux}" ;;
  *) row os info "$os (unsupported)" ;;
esac

# Docker-compatible runtime: the CLI must exist and the daemon must answer.
if have docker; then
  if docker info >/dev/null 2>&1; then
    ctx="$(docker context show 2>/dev/null)"
    runtime="docker"
    [ -d /Applications/OrbStack.app ] && runtime="OrbStack"
    [ -d /Applications/Docker.app ] && runtime="Docker Desktop"
    have colima && colima status >/dev/null 2>&1 && runtime="Colima"
    row docker ok "$(first_line docker --version); daemon running; context=${ctx:-unknown}; runtime=${runtime}"
  else
    row docker missing "docker CLI present but the daemon is not reachable; start OrbStack, Docker Desktop or Colima"
  fi
else
  row docker missing "no docker CLI"
fi
if have docker && docker compose version >/dev/null 2>&1; then
  row docker-compose ok "$(first_line docker compose version)"
else
  row docker-compose missing "Docker Compose v2 plugin"
fi

# Workspace runtime: either DevPod or Devsy is enough.
if have devpod; then row devpod ok "$(first_line devpod version)"; else row devpod missing "optional if Devsy is used"; fi
if have devsy; then row devsy ok "$(first_line devsy --version)"; else row devsy missing "optional if DevPod is used"; fi

# Node >= 24 per the devrouter package engines.
if have node; then
  nv="$(node --version)"
  major="${nv#v}"; major="${major%%.*}"
  if [ "$major" -ge 24 ] 2>/dev/null; then row node ok "$nv"; else row node missing "$nv found, 24 or newer required"; fi
else
  row node missing "no node"
fi
managers=""
for m in volta fnm nvm asdf mise; do
  if have "$m" || { [ "$m" = nvm ] && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; }; then managers="$managers $m"; fi
done
row node-manager info "${managers:- none detected}"

have pnpm && row pnpm ok "$(first_line pnpm --version)" || row pnpm missing "only needed to work on devrouter itself"
have mkcert && row mkcert ok "$(first_line mkcert --version)" || row mkcert missing "needed for trusted HTTPS"
have git && row git ok "$(first_line git --version)" || row git missing "no git"
have gh && row gh ok "$(first_line gh --version)" || row gh missing "optional, GitHub CLI"
have glab && row glab ok "$(first_line glab --version)" || row glab missing "optional, GitLab CLI"

# Installed devrouter versus the repository minimum.
if have devrouter; then
  installed="$(devrouter --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+[^ ]*' | head -n 1)"
  row devrouter ok "${installed:-installed, version unreadable}"
else
  installed=""
  row devrouter missing "run: npm install -g @devrouter/cli"
fi
cfg="$repo/.devrouter.yml"
if [ -f "$cfg" ]; then
  min="$(awk '/^devrouter:/{f=1;next} f&&/^[^ ]/{f=0} f&&/^[ ]+version:/{gsub(/["'"'"' ]/,"",$2);print $2;exit}' "$cfg")"
  if [ -z "$min" ]; then
    row repo-minimum info "$cfg has no devrouter.version"
  elif [ -z "$installed" ]; then
    row repo-minimum missing "requires $min; devrouter not installed"
  elif [ "$(printf '%s\n%s\n' "$min" "$installed" | sort -V | head -n 1)" = "$min" ]; then
    row repo-minimum ok "requires $min, installed $installed"
  else
    row repo-minimum missing "requires $min, installed $installed; run: npm install -g @devrouter/cli@latest"
  fi
else
  row repo-minimum info "no .devrouter.yml in $repo"
fi
