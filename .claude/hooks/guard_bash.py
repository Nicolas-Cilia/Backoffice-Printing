#!/usr/bin/env python3
"""PreToolUse guard for Bash: mechanical enforcement of the repo's git rules.

Denies (before the command runs):
  * git push that targets main (explicit refspec, or implicit while on main)
  * git push --force to main or dev
  * gh pr create whose base is not dev (the repo default is main, so a missing
    --base means main)
  * git commit that would include the tracked built UI under static/

Reads the hook JSON on stdin, prints a PreToolUse decision on stdout.
"""

import json
import os
import re
import shlex
import subprocess
import sys

THIS_REPO = "backoffice-printing"  # substring of the origin URL; rules apply only here
PROTECTED_PUSH = {"main", "master"}
PROTECTED_FORCE = {"main", "master", "dev"}
REQUIRED_PR_BASE = "dev"
# Standing rule (Wes 2026-09-04): Claude never touches the warehouse Mac.
# Hostnames/IPs live in .claude/hooks/protected-hosts.txt (gitignored; see the
# .example file) so the public repo never carries LAN addresses.
_HOSTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "protected-hosts.txt")


def protected_hosts() -> list[str]:
    hosts = ["warehouse-mac", "backoffice-mac"]
    try:
        with open(_HOSTS_FILE, encoding="utf-8") as fh:
            hosts += [ln.strip().lower() for ln in fh if ln.strip() and not ln.startswith("#")]
    except OSError:
        pass
    return hosts


def deny(reason: str) -> None:
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            }
        )
    )
    sys.exit(0)


def norm_cwd(cwd: str) -> str:
    """Git Bash hands us /c/Users/...; Python on Windows needs C:/Users/..."""
    m = re.match(r"^/([A-Za-z])/(.*)$", cwd or "")
    if m and os.name == "nt":
        cwd = f"{m.group(1).upper()}:/{m.group(2)}"
    return cwd if cwd and os.path.isdir(cwd) else os.getcwd()


def git(args: list[str], cwd: str) -> str:
    try:
        return subprocess.run(
            ["git", *args], cwd=cwd, capture_output=True, text=True, timeout=15
        ).stdout.strip()
    except Exception:
        return ""


def segments(command: str) -> list[list[str]]:
    """Split a shell command on && || ; | and newlines, tokenize each part."""
    parts = re.split(r"&&|\|\||;|\||\n", command)
    out = []
    for part in parts:
        try:
            toks = shlex.split(part, posix=True)
        except ValueError:
            toks = part.split()
        # drop leading env assignments / wrappers like `env -u GH_TOKEN`
        while toks and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", toks[0]) or toks[0] == "env"):
            toks.pop(0)
            while toks and toks[0].startswith("-"):
                toks.pop(0)
                if toks and toks[0] and not toks[0].startswith("-"):
                    toks.pop(0)
        if toks:
            out.append(toks)
    return out


def strip_git_globals(toks: list[str]) -> list[str]:
    """`git -c a=b -C dir push ...` -> ['git', 'push', ...]"""
    i = 1
    while i < len(toks):
        t = toks[i]
        if t in ("-c", "-C", "--git-dir", "--work-tree"):
            i += 2
        elif t.startswith("-") and t not in ("--",):
            i += 1
        else:
            break
    return ["git", *toks[i:]]


def effective_cwd(prior: list[list[str]], cwd: str) -> str:
    """Follow `cd <dir>` segments that ran before this one."""
    for toks in prior:
        if toks and toks[0] == "cd" and len(toks) > 1:
            target = os.path.expanduser(os.path.expandvars(toks[1]))
            target = norm_cwd(target) if os.path.isabs(target) or target.startswith("/") else os.path.join(cwd, target)
            if os.path.isdir(target):
                cwd = target
    return cwd


def is_this_repo(toks: list[str], cwd: str) -> bool:
    """True if the push goes to this repo's remote. Unknown -> True (fail closed)."""
    for i, t in enumerate(toks):
        if t == "-C" and i + 1 < len(toks):
            cwd = norm_cwd(os.path.expanduser(os.path.expandvars(toks[i + 1])))
    args = [t for t in toks[2:] if not t.startswith("-")]
    remote = args[0] if args else "origin"
    url = git(["remote", "get-url", remote], cwd)
    if not url:
        top = git(["rev-parse", "--show-toplevel"], cwd)
        return THIS_REPO in top.lower() if top else True
    return THIS_REPO in url.lower()


def check_push(toks: list[str], cwd: str, raw: list[str]) -> None:
    if not is_this_repo(raw, cwd):
        return
    args = [t for t in toks[2:]]
    force = any(t in ("-f", "--force", "--force-with-lease") or t.startswith("--force") for t in args)
    positional = [t for t in args if not t.startswith("-")]
    # positional: [remote, refspec...]
    refspecs = positional[1:] if positional else []
    targets = set()
    for r in refspecs:
        dst = r.split(":", 1)[1] if ":" in r else r
        dst = dst.lstrip("+")
        dst = dst.replace("refs/heads/", "")
        targets.add(dst)
    if not refspecs:
        head = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)
        if head:
            targets.add(head)
    hit = targets & PROTECTED_PUSH
    if hit:
        deny(
            f"BLOCKED by .claude/hooks/guard_bash.py: pushing to {sorted(hit)} is forbidden. "
            "Fork work never lands on main; open a PR against dev instead (CLAUDE.md > Git and PRs)."
        )
    if force and targets & PROTECTED_FORCE:
        deny(
            f"BLOCKED: force-push to {sorted(targets & PROTECTED_FORCE)} is forbidden (CLAUDE.md > Git and PRs)."
        )


def check_pr_create(toks: list[str]) -> None:
    base = None
    for i, t in enumerate(toks):
        if t in ("--base", "-B") and i + 1 < len(toks):
            base = toks[i + 1]
        elif t.startswith("--base="):
            base = t.split("=", 1)[1]
    if base != REQUIRED_PR_BASE:
        shown = base if base else "(none, which defaults to main)"
        deny(
            f"BLOCKED: gh pr create must use --base {REQUIRED_PR_BASE}; got {shown}. "
            "PRs target dev, never main (CLAUDE.md > Git and PRs)."
        )


def check_commit(toks: list[str], cwd: str) -> None:
    staged = git(["diff", "--cached", "--name-only"], cwd).splitlines()
    offenders = [p for p in staged if p.startswith("static/")]
    if any(t in ("-a", "--all") or (t.startswith("-") and not t.startswith("--") and "a" in t[1:]) for t in toks[2:]):
        dirty = git(["status", "--porcelain", "--", "static/"], cwd).splitlines()
        offenders += [line[3:] for line in dirty if not line.startswith("??")]
    if offenders:
        sample = ", ".join(offenders[:3]) + (" ..." if len(offenders) > 3 else "")
        deny(
            f"BLOCKED: this commit would include the built UI under static/ ({sample}). "
            "Run `git checkout -- static` (and `git restore --staged static`) first (CLAUDE.md > Repo gotchas)."
        )


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return
    if payload.get("tool_name") != "Bash":
        return
    command = (payload.get("tool_input") or {}).get("command") or ""
    cwd = norm_cwd(payload.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())

    low = command.lower()
    for marker in protected_hosts():
        if marker in low:
            deny(
                f"BLOCKED: command references the warehouse Mac ({marker}). Standing rule: Claude never "
                "touches the Mac — no HTTP, SSH, backup, deploy, or read. Hand instructions to Wes or Gaspi (CLAUDE.md > Deploy)."
            )

    segs = segments(command)
    for idx, raw in enumerate(segs):
        toks = raw
        prog = os.path.basename(toks[0]).lower()
        here = effective_cwd(segs[:idx], cwd)
        if prog in ("git", "git.exe"):
            toks = strip_git_globals(toks)
            if len(toks) < 2:
                continue
            sub = toks[1]
            if sub == "push":
                check_push(toks, here, raw)
            elif sub == "commit" and is_this_repo(raw, here):
                check_commit(toks, here)
        elif prog in ("gh", "gh.exe") and len(toks) >= 3 and toks[1] == "pr" and toks[2] == "create":
            check_pr_create(toks)


if __name__ == "__main__":
    main()
