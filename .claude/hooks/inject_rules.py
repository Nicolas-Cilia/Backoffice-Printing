#!/usr/bin/env python3
"""Re-inject the project's core rules so they survive long contexts and compaction.

  inject_rules.py digest   -> UserPromptSubmit: the short digest, every turn
  inject_rules.py full     -> PostCompact / SessionStart: the whole CLAUDE.md

The harness runs this, not Claude, so the rules reappear whether or not the
model remembers them.
"""

import json
import os
import sys

ROOT = os.environ.get("CLAUDE_PROJECT_DIR") or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EVENT = {"digest": "UserPromptSubmit", "full": "PostCompact"}


def read(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "digest"
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    event = payload.get("hook_event_name") or EVENT.get(mode, "UserPromptSubmit")

    if mode == "full":
        body = read(os.path.join(ROOT, "CLAUDE.md"))
        header = "Context was compacted. Project rules, re-injected mechanically by .claude/hooks (CLAUDE.md):"
    else:
        body = read(os.path.join(ROOT, ".claude", "hooks", "rules-digest.md"))
        header = "Standing project rules (mechanically re-injected each turn; full text in CLAUDE.md):"
    if not body:
        return
    print(
        json.dumps(
            {
                "suppressOutput": True,
                "hookSpecificOutput": {"hookEventName": event, "additionalContext": f"{header}\n{body}"},
            }
        )
    )


if __name__ == "__main__":
    main()
