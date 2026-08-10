#!/bin/bash
# Auto-land unlanded ensync/chat-* branches in all Ensync project repos.
# Called by the com.ensync.auto-land launchd job every 5 minutes.

LOG="/tmp/ensync-auto-land.log"

echo "--- $(date) ---" >> "$LOG"

for repo in /Users/mikeyhasson/dev/relay /Users/mikeyhasson/dev/nadlan-desk; do
  if [ -d "$repo/.git" ]; then
    cd "$repo" || continue
    /opt/homebrew/opt/node@22/bin/node scripts/auto-land.mjs >> "$LOG" 2>&1
  fi
done
