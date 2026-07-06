#!/usr/bin/env sh
# Load .env.local, then run the given command.
#
# Why this exists: Next.js (and the tsx scripts) let a variable that's already
# exported in the shell win over .env.local. In this sandbox the shell exports an
# ANTHROPIC_API_KEY that can't make direct API calls, which shadows the real key in
# .env.local and makes every agent/kickoff call 401. Sourcing .env.local here with
# `set -a` re-exports its values so they take precedence, then we exec the command.
#
# Expects simple KEY=value lines (the dotenv format this project uses).
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$DIR/.env.local" ]; then
  set -a
  . "$DIR/.env.local"
  set +a
fi
exec "$@"
