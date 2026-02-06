# Git Version Control & Rollback Guide

## 📋 Overview

This document describes the Git versioning strategy and rollback procedures for the Twilio Call Viewer project.

## 🎯 Purpose

- **Safe Development:** Enable quick rollback if changes break functionality
- **Version Tracking:** Maintain clear history of changes
- **Debugging Safety:** Prevent regressions during AI-assisted development
- **Change Isolation:** Keep commits focused and reversible

## 🏗️ Repository Setup

### Initial Commit

```bash
Commit: 9163155
Message: feat: Phase 1 - Initial project setup with React frontend and backend infrastructure
Files: 41 files, 2388 insertions
```

**This commit includes:**
- ✅ Backend infrastructure (Express server, services, webhooks)
- ✅ Frontend React app (UI components, routing, state management)
- ✅ Test suite (27 passing tests)
- ✅ Configuration files (.gitignore, package.json, vite.config.ts)

### Current Status

```
Branch: master
Commit: 9163155
Status: Clean working tree ✅
```

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
4. **Working Tree:** Ensure working tree is clean before starting new work
5. **Frequency:** Commit after completing each meaningful unit of work

## 🔄 Development Workflow

### Before Starting New Work

```bash
# 1. Check current status
git status

# 2. Ensure working tree is clean
# If changes exist, commit or stash them:
git add .
git commit -m "feat: description of changes"

# OR stash for later:
git stash push -m "WIP: description"

# 3. Create checkpoint tag (optional)
git tag phase-1-complete
```

### During Development

```bash
# 1. Make changes to files
# ... edit code ...

# 2. Check what changed
git status
git diff

# 3. Stage changes
git add <file1> <file2>
# OR stage all:
git add .

# 4. Commit with descriptive message
git commit -m "feat: Add conversation API endpoints

- Implement GET /api/conversations
- Implement GET /api/conversations/:id
- Add error handling and validation

Related to: Phase 2 - Backend API"
```

### After Completing a Task

```bash
# 1. Verify all changes are committed
git status
# Should show: "nothing to commit, working tree clean"

# 2. Review commit history
git log --oneline -5

# 3. Create a tag for major milestones
git tag -a v0.2.0 -m "Phase 2: Backend API Complete"
```

## ⏪ Rollback Procedures

### Scenario 1: Uncommitted Changes (Not Working)

**Problem:** Made changes that broke something, changes NOT committed yet

**Solution: Discard uncommitted changes**
```bash
# Option A: Discard ALL uncommitted changes
git reset --hard HEAD

# Option B: Discard specific file
git checkout -- <filename>

# Option C: Discard all changes but keep new files
git reset --hard
git clean -fd
```

### Scenario 2: Last Commit Broke Something

**Problem:** Just committed changes that broke functionality

**Solution: Undo last commit**
```bash
# Option A: Undo commit but keep changes (can fix and recommit)
git reset --soft HEAD~1

# Option B: Undo commit and discard changes completely
git reset --hard HEAD~1
```

**Example:**
```bash
# Before (broken state)
$ git log --oneline
abc1234 (HEAD -> master) feat: Add broken database queries
9163155 feat: Phase 1 - Initial project setup

# Rollback
$ git reset --hard HEAD~1

# After (working state restored)
$ git log --oneline
9163155 (HEAD -> master) feat: Phase 1 - Initial project setup
```

### Scenario 3: Multiple Commits Ago

**Problem:** Changes from several commits ago broke things

**Solution: Reset to specific commit**
```bash
# 1. Find the good commit
git log --oneline

# 2. Reset to that commit
git reset --hard <commit-hash>

# Example:
git reset --hard 9163155
```

### Scenario 4: Need to Keep Some Recent Changes

**Problem:** Want to rollback but preserve some files

**Solution: Cherry-pick approach**
```bash
# 1. Save current state
git stash

# 2. Reset to good state
git reset --hard <good-commit>

# 3. Restore specific files from stash
git checkout stash@{0} -- <file1> <file2>

# 4. Review and commit
git add <files>
git commit -m "fix: Restore working files after rollback"
```

### Scenario 5: Already Pushed to Remote

**Problem:** Bad commit already pushed to remote repository

**Solution: Revert (safer) or Force push**
```bash
# Option A: Create revert commit (RECOMMENDED)
git revert <bad-commit-hash>
# This creates a NEW commit that undoes the bad one

# Option B: Force push (USE WITH CAUTION)
git reset --hard <good-commit>
git push --force origin master
# ⚠️ Only if you're sure no one else has pulled the bad commit
```

## 📋 Quick Reference Commands

### Check Status
```bash
# Current status
git status

# View recent commits
git log --oneline -10

# View all tags
git tag -l

# See what changed
git diff
git diff HEAD~1  # Compare with previous commit
```

### Safe Rollback (Most Common)
```bash
# Undo last commit, keep changes
git reset --soft HEAD~1

# Undo last commit, discard changes
git reset --hard HEAD~1

# Return to specific commit
git reset --hard <commit-hash>

# Return to Phase 1
git reset --hard 9163155
```

### Create Checkpoints
```bash
# Create named tag
git tag phase-2-start
git tag phase-2-database-complete

# View all tags
git tag -l

# Return to tagged version
git checkout phase-1-complete
```

## 🛡️ Best Practices

### DO:
✅ Commit frequently (after each logical change)  
✅ Write descriptive commit messages  
✅ Check `git status` before and after commits  
✅ Create tags for major milestones  
✅ Test before committing  
✅ Keep commits focused and small  

### DON'T:
❌ Mix unrelated changes in one commit  
❌ Commit broken code (unless WIP branch)  
❌ Leave working tree dirty before new work  
❌ Force push to shared branches  
❌ Commit sensitive data (API keys, passwords)  

## 📊 Project Milestones & Tags

Current milestones:

```
v0.1.0 (9163155) - Phase 1 Complete
├── Backend infrastructure
├── Frontend React app
└── Test suite (27 tests)

[Next: v0.2.0 - Phase 2: Backend API]
```

Planned tags:
- `phase-2-database` - Database schema complete
- `phase-2-api` - API endpoints complete
- `phase-2-sync` - Twilio sync service complete
- `v0.2.0` - Phase 2 complete

## 🚨 Emergency Rollback

If everything is broken and you're not sure what to do:

```bash
# 1. Stop and check where you are
git status
git log --oneline -5

# 2. Return to last known good state (Phase 1)
git reset --hard 9163155

# 3. Verify it works
npm run dev  # Backend
cd frontend && npm run dev  # Frontend

# 4. Start over from clean state
```

## 📝 Workflow Example

Complete example of safe development cycle:

```bash
# === Starting Phase 2 ===

# 1. Verify clean state
$ git status
On branch master
nothing to commit, working tree clean ✅

# 2. Tag starting point
$ git tag phase-2-start

# 3. Make changes (e.g., add database schema)
$ nano backend/src/db/schema.sql
$ nano backend/src/db/queries.js

# 4. Test changes
$ npm test

# 5. Commit if working
$ git add backend/src/db/
$ git commit -m "feat: Add PostgreSQL database schema

- Create contacts table with phone number handling
- Create conversations table with metadata
- Create messages table for call records
- Add indexes for performance

Related to: Phase 2 - Database Integration"

# 6. Continue with next feature (API endpoints)
$ nano backend/src/routes/conversations.js

# 7. If this breaks something:
$ git reset --hard HEAD~1  # Rollback to database commit
# OR
$ git reset --hard phase-2-start  # Rollback to start of Phase 2
```

## 🔗 Useful Resources

- [Git Documentation](https://git-scm.com/doc)
- [How to Write a Git Commit Message](https://chris.beams.io/posts/git-commit/)
- [Git Cheat Sheet](https://education.github.com/git-cheat-sheet-education.pdf)

---

**Current State:**
- Repository: Initialized ✅
- Phase 1: Committed (9163155) ✅
- Working Tree: Clean ✅
- Ready for: Phase 2 Development ✅
