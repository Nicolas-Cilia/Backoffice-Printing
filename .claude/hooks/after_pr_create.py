#!/usr/bin/env python3
"""PostToolUse hook for Bash: after `gh pr create`, request Gaspi as reviewer.

Standing rule (Wes, 2026-09-04): PRs to main get gasparhabif as a reviewer;
PRs to dev do not. GitHub silently drops reviewer requests for
non-collaborators, so this hook verifies the request landed and reports
loudly when it did not.
"""

import json
import os
import re
import shlex
import subprocess
import sys

REVIEWER = "gasparhabif"
REVIEW_BASE = "main"
PR_URL_RE = re.compile(r"https://github\.com/([\w.-]+)/([\w.-]+)/pull/(\d+)")


def run(args: list[str], env: dict) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, timeout=60, env=env)


def gh(args: list[str]) -> subprocess.CompletedProcess:
    """Run gh; if the ambient GH_TOKEN is dead (401), retry with the keyring."""
    env = dict(os.environ)
    res = run(["gh", *args], env)
    if res.returncode != 0 and ("401" in res.stderr or "Bad credentials" in res.stderr) and "GH_TOKEN" in env:
        env.pop("GH_TOKEN", None)
        res = run(["gh", *args], env)
    return res


def is_pr_create(command: str) -> bool:
    """True only when some shell segment *starts* with `gh pr create` (not echoed text)."""
    for part in re.split(r"&&|\|\||;|\||\n", command):
        try:
            toks = shlex.split(part, posix=True)
        except ValueError:
            toks = part.split()
        while toks and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", toks[0]) or toks[0] == "env"):
            toks.pop(0)
            while toks and toks[0].startswith("-"):
                toks.pop(0)
                if toks and not toks[0].startswith("-"):
                    toks.pop(0)
        if len(toks) >= 3 and os.path.basename(toks[0]).lower() in ("gh", "gh.exe") and toks[1:3] == ["pr", "create"]:
            return True
    return False


def emit(text: str) -> None:
    print(
        json.dumps(
            {
                "systemMessage": text,
                "hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": text},
            }
        )
    )


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return
    if payload.get("tool_name") != "Bash":
        return
    command = (payload.get("tool_input") or {}).get("command") or ""
    if not re.search(r"\bgh(\.exe)?\s+pr\s+create\b", command):
        return

    resp = payload.get("tool_response") or {}
    blob = " ".join(str(resp.get(k, "")) for k in ("stdout", "stderr", "output", "content")) + " " + json.dumps(resp)
    m = PR_URL_RE.search(blob)
    if not m:
        if "pull" not in blob and "github.com" not in blob:
            return  # command mentioned gh pr create but never actually ran it
        emit(
            f"PR-reviewer hook: could not find a PR URL in the gh output, so {REVIEWER} was NOT requested. "
            f"Run `gh pr edit <n> --add-reviewer {REVIEWER}` manually and verify."
        )
        return
    owner, repo, num = m.groups()
    url = m.group(0)

    base = gh(["pr", "view", url, "--json", "baseRefName", "-q", ".baseRefName"]).stdout.strip()
    if base != REVIEW_BASE:
        # Wes 2026-09-04: Gaspi reviews promotions to main only, not dev PRs.
        emit(f"PR-reviewer hook: {url} targets '{base}', so no reviewer requested ({REVIEWER} reviews PRs to {REVIEW_BASE} only).")
        return

    res = gh(["pr", "edit", url, "--add-reviewer", REVIEWER])
    check = gh(["api", f"repos/{owner}/{repo}/pulls/{num}/requested_reviewers", "-q", ".users[].login"])
    logins = {line.strip() for line in check.stdout.splitlines() if line.strip()}
    base_note = ""

    if REVIEWER in logins:
        emit(f"PR-reviewer hook: {REVIEWER} requested as reviewer on {url}.{base_note}")
    else:
        why = (res.stderr.strip() or check.stderr.strip() or "GitHub accepted the edit but dropped the request")
        emit(
            f"PR-reviewer hook: {REVIEWER} is NOT a requested reviewer on {url}. Reason: {why}. "
            f"Most likely {REVIEWER} is not a collaborator on {owner}/{repo}; Wes must invite him under "
            f"Settings > Collaborators, then run `gh pr edit {url} --add-reviewer {REVIEWER}`.{base_note}"
        )


if __name__ == "__main__":
    main()
