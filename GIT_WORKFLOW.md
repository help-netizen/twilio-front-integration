# GitHub Flow + Feature Flags — Git Version Control & Rollback Guide

## 📋 Overview

This document describes a **safe Git workflow (GitHub Flow)** and **rollback procedures** for the Twilio Call Viewer project.
It is designed to let multiple features be developed in parallel with minimal conflicts and a stable `main` branch.

## 🎯 Purpose

- **Safe Development:** Enable quick rollback if changes break functionality
- **Version Tracking:** Maintain clear history of changes
- **Debugging Safety:** Prevent regressions during AI-assisted development
- **Change Isolation:** Keep commits focused, reviewable, and reversible
- **Parallel Work:** Multiple feature branches without stepping on each other

---

## 🏗️ Repository Setup

### Default Branch

- Default branch: `main` (stable, deployable)
- Direct commits to `main`: **NOT allowed** (PR/MR only)

> If your repo currently uses `master`, rename it to `main` to match this guide.

### Recommended Branch Protection (GitHub Settings)

Enable on `main`:
- Require PR before merging
- Require status checks to pass (tests/linters)
- Require linear history (optional but recommended if you use rebase/squash)
- Restrict who can push to `main`
- Require signed commits (optional)

---

## 🌿 Branching Model (GitHub Flow)

### Rule 1 — One feature/fix = one branch

Create a branch from `main` for every task:

Naming conventions:
- `feature/<short-name>`
- `fix/<short-name>`
- `chore/<short-name>`
- `refactor/<short-name>`

Examples:
- `feature/customer-create`
- `feature/zenbooker-sync`
- `fix/pagination-null-cursor`

Commands:
```bash
git checkout main
git pull
git checkout -b feature/customer-create
```

### Rule 2 — Keep branches small and short-lived

- Prefer PRs that can be merged within **1–3 days**
- Avoid “mega-PRs” that touch many unrelated files
- If a feature is large, split into multiple PRs behind a **feature flag**

---

## 🚦 Feature Flags (recommended for big features)

Feature flags let you merge work safely even if the feature is not fully ready yet.

### What to flag

- New UI screens or flows
- Risky refactors that change behavior
- Integrations (e.g., Zenbooker sync, Twilio ingestion changes)

### Simple implementation patterns

**Frontend (React):**
- `.env` flag: `VITE_FEATURE_ZENBOOKER_SYNC=true`
- Toggle in code:
```ts
const ENABLE_ZENBOOKER_SYNC = import.meta.env.VITE_FEATURE_ZENBOOKER_SYNC === "true";
```

**Backend (Node/Express):**
- `.env` flag: `FEATURE_ZENBOOKER_SYNC=true`
- Toggle in code:
```js
const ENABLE_ZENBOOKER_SYNC = process.env.FEATURE_ZENBOOKER_SYNC === "true";
```

### Rules for flags

- Default to **OFF** in production unless explicitly enabled
- Name flags consistently: `FEATURE_<NAME>` / `VITE_FEATURE_<NAME>`
- Remove flags when the feature is fully rolled out

---

## 📝 Commit Guidelines

### Commit Message Format

```
<type>: <subject>

<body>

<footer>
```

**Types:**
- `feat:` New feature
- `fix:` Bug fix
- `refactor:` Code refactoring
- `test:` Adding/updating tests
- `docs:` Documentation changes
- `style:` Code style changes (formatting)
- `chore:` Maintenance tasks

**Example:**
```bash
git commit -m "feat: Add PostgreSQL database schema for conversations

- Create contacts table
- Create conversations table
- Create messages table
- Add indexes for performance

Related to: Phase 2 - Database Integration"
```

### Commit Rules

1. **Scope:** Each commit should address ONE logical change
2. **Size:** Keep commits small and focused
3. **Description:** Message must reference the task/issue
4. **Working Tree:** Ensure working tree is clean before switching tasks
5. **Frequency:** Commit after each meaningful unit of work

---

## 🔄 Development Workflow (GitHub Flow)

### Before Starting New Work

```bash
# 1. Ensure you're up to date
git checkout main
git pull

# 2. Create a new branch for the task
git checkout -b feature/<short-name>
```

### During Development (daily loop)

```bash
# 1. Edit code
# ... make changes ...

# 2. Inspect changes
git status
git diff

# 3. Run tests (or at least lint)
npm test

# 4. Commit a small, logical chunk
git add .
git commit -m "feat: Add conversation API endpoints"

# 5. Push your branch
git push -u origin feature/<short-name>
```

### Keep Your Branch Updated (avoid conflicts)

**Option A (recommended for clean history): rebase onto latest `main`**
```bash
git fetch origin
git rebase origin/main
```

If your branch is shared with someone else, prefer **merge** instead:

**Option B: merge latest `main`**
```bash
git fetch origin
git merge origin/main
```

### Open a Pull Request (PR)

PR checklist:
- ✅ Tests/linters pass
- ✅ Changes are limited to a single scope
- ✅ Feature flag used if feature is incomplete/risky
- ✅ No secrets (API keys) committed
- ✅ Clear PR description + screenshots/logs if relevant

### Merge Strategy

Pick ONE merge strategy for consistency:

- **Squash & merge (recommended):** one clean commit per PR
- **Rebase & merge:** linear history, also clean
- **Merge commit:** ok, but can get noisy

After merge:
- Delete the feature branch (GitHub option)
- Pull latest `main`

---

## ⏪ Rollback Procedures (safe + GitHub Flow)

> Key principle: **If it’s already merged/pushed to shared `main`, use `git revert`.**
> Use `reset --hard` only on local or private branches.

### Scenario 1: Uncommitted Changes (Not Working)

**Problem:** You made changes that broke something, not committed yet.

**Solution: discard or stash**
```bash
# Discard all uncommitted changes
git reset --hard HEAD

# Remove untracked files (careful!)
git clean -fd

# OR stash changes to recover later
git stash push -m "WIP: <short-note>"
```

### Scenario 2: Last Commit on Your Feature Branch Broke Something

**Problem:** You committed broken code on your feature branch.

**Solution A: undo last commit but keep changes**
```bash
git reset --soft HEAD~1
```

**Solution B: undo last commit and discard changes**
```bash
git reset --hard HEAD~1
```

### Scenario 3: PR Merged into `main` and Broke Production

**Problem:** Bad change is already in `main`.

**Solution (recommended): revert the merge commit or bad commit**
```bash
git checkout main
git pull
git revert <bad-commit-hash>
git push origin main
```

This creates a NEW commit that safely undoes the change without rewriting history.

### Scenario 4: Need to Roll Back to a Known Good State (Local/Private)

**Problem:** You need to jump back to a known good commit (local only).

```bash
git log --oneline
git reset --hard <good-commit-hash>
```

> Avoid force-pushing this to shared branches. If `main` is shared, use **revert**.

### Scenario 5: Preserve Some Work While Rolling Back

```bash
# Save your current work
git stash push -m "WIP: before rollback"

# Reset to good commit
git reset --hard <good-commit-hash>

# Restore only selected files
git checkout stash@{0} -- <file1> <file2>

# Commit restored pieces
git add <files>
git commit -m "fix: Restore selected files after rollback"
```

---

## 🏷️ Tags & Releases (optional, but helpful)

Use tags for major milestones/releases:

```bash
git tag -a v0.2.0 -m "Phase 2 complete"
git push --tags
```

Recommended tag naming:
- `v0.1.0`, `v0.2.0` … for releases
- `phase-2-start`, `phase-2-api`, `phase-2-sync` … for internal milestones

---

## 📋 Quick Reference Commands

### Daily essentials
```bash
git status
git log --oneline -10
git diff
```

### Start a new feature (GitHub Flow)
```bash
git checkout main
git pull
git checkout -b feature/<short-name>
```

### Update your branch
```bash
git fetch origin
git rebase origin/main   # recommended
# or:
git merge origin/main
```

### Safe rollback
```bash
git revert <commit>         # safe for shared main
git reset --hard HEAD~1     # local/private branches only
```

---

## 🛡️ Best Practices (what actually prevents conflicts)

### DO:
✅ Keep PRs small (merge frequently)  
✅ Rebase/merge from `main` daily  
✅ Use feature flags for large/risky features  
✅ Split refactors into a separate PR before feature work  
✅ Avoid having two branches heavily edit the same file/module  
✅ Add tests around bug fixes (so the bug can’t return silently)  

### DON'T:
❌ Commit directly to `main`  
❌ Keep long-lived branches for weeks  
❌ Force-push shared branches  
❌ Mix refactor + feature + formatting in one PR  
❌ Store secrets in git history  

---

## 📝 Workflow Example (parallel features)

```bash
# Feature A: customer create
git checkout main && git pull
git checkout -b feature/customer-create
# ... work, commit, push, PR ...

# Feature B: pagination fixes (in parallel)
git checkout main && git pull
git checkout -b fix/pagination-null-cursor
# ... work, commit, push, PR ...

# Keep both branches up to date:
git fetch origin
git rebase origin/main
```

---

## 🚨 Emergency “Stop the Bleeding” (shared main)

If `main` is broken after a merge:
1) Identify the bad commit in GitHub/CI
2) Run:
```bash
git checkout main
git pull
git revert <bad-commit-hash>
git push origin main
```
3) Open a follow-up PR to fix properly behind a feature flag if needed

---

## 🔗 Useful Resources

- [Git Documentation](https://git-scm.com/doc)
- [How to Write a Git Commit Message](https://chris.beams.io/posts/git-commit/)
- [Git Cheat Sheet](https://education.github.com/git-cheat-sheet-education.pdf)
