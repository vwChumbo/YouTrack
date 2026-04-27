# CodeCommit to GitHub Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate YouTrack infrastructure repository from non-compliant CodeCommit to GitHub while preserving production data and removing CI/CD infrastructure.

**Architecture:** Sequential safe migration that establishes GitHub as source of truth before destroying AWS resources. Production stacks (YouTrackStack-Local, AutomationStack-Local) remain untouched throughout the process.

**Tech Stack:** Git, AWS CDK, AWS CloudFormation, GitHub

---

## Task 1: Repository Migration to GitHub

**Files:**
- No file changes (git configuration only)

**Step 1: Add GitHub remote**

```bash
git remote add origin https://github.com/vwChumbo/YouTrack.git
```

Expected: No output (command succeeds silently)

**Step 2: Rename branch to main**

```bash
git branch -M main
```

Expected: No output (branch renamed)

**Step 3: Push code to GitHub**

```bash
git push -u origin main
```

Expected output:
```
Enumerating objects: X, done.
Counting objects: 100% (X/X), done.
...
To https://github.com/vwChumbo/YouTrack.git
 * [new branch]      main -> main
```

**Step 4: Verify GitHub repository**

Open in browser: `https://github.com/vwChumbo/YouTrack`

Expected: Repository shows all files including CLAUDE.md, lib/, bin/, etc.

**Step 5: Remove CodeCommit remote**

```bash
git remote remove codecommit
```

Expected: No output (remote removed silently)

**Step 6: Verify git configuration**

```bash
git remote -v
```

Expected output:
```
origin  https://github.com/vwChumbo/YouTrack.git (fetch)
origin  https://github.com/vwChumbo/YouTrack.git (push)
```

---

## Task 2: Destroy PipelineStack

**Files:**
- No file changes (AWS infrastructure only)

**Step 1: Destroy PipelineStack via CDK**

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk destroy PipelineStack
```

Expected: Prompt asking for confirmation, type 'y' and press Enter

Expected output:
```
PipelineStack: destroying...
...
 ✅  PipelineStack: destroyed
```

**Step 2: Verify stack deletion**

```bash
aws cloudformation list-stacks --region eu-west-1 --stack-status-filter DELETE_COMPLETE --query 'StackSummaries[?StackName==`PipelineStack`].{Name:StackName,Status:StackStatus}' --output table
```

Expected output: Table showing PipelineStack with DELETE_COMPLETE status

**Step 3: Verify production stacks are intact**

```bash
aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1 --query 'Stacks[0].StackStatus' --output text
```

Expected output: `CREATE_COMPLETE` or `UPDATE_COMPLETE`

```bash
aws cloudformation describe-stacks --stack-name AutomationStack-Local --region eu-west-1 --query 'Stacks[0].StackStatus' --output text
```

Expected output: `CREATE_COMPLETE` or `UPDATE_COMPLETE`

---

## Task 3: Move Pipeline Code to Deprecated

**Files:**
- Move: `lib/pipeline-stack.ts` → `deprecated/pipeline/pipeline-stack.ts`

**Step 1: Create deprecated directory**

```bash
mkdir -p deprecated/pipeline
```

Expected: No output (directory created)

**Step 2: Move pipeline-stack.ts**

```bash
git mv lib/pipeline-stack.ts deprecated/pipeline/
```

Expected output:
```
Rename from lib/pipeline-stack.ts to deprecated/pipeline/pipeline-stack.ts
```

**Step 3: Verify file moved**

```bash
ls deprecated/pipeline/
```

Expected output:
```
pipeline-stack.ts
```

**Step 4: Commit the move**

```bash
git add deprecated/pipeline/pipeline-stack.ts
git commit -m "refactor: move pipeline-stack.ts to deprecated directory"
```

Expected output:
```
[main XXXXXXX] refactor: move pipeline-stack.ts to deprecated directory
 1 file changed, 0 insertions(+), 0 deletions(-)
 rename lib/pipeline-stack.ts => deprecated/pipeline/pipeline-stack.ts (100%)
```

---

## Task 4: Update Application Entry Point

**Files:**
- Modify: `bin/youtrack-app.ts`

**Step 1: Remove PipelineStack import and instantiation**

Edit `bin/youtrack-app.ts` to match this exact content:

```typescript
#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { YouTrackStack } from '../lib/youtrack-stack';
import { AutomationStack } from '../lib/automation-stack';

const app = new cdk.App();

// YouTrack deployment for local deployment
const youtrackStack = new YouTrackStack(app, 'YouTrackStack-Local', {
  env: {
    account: '640664844884',
    region: 'eu-west-1'
  },
});

new AutomationStack(app, 'AutomationStack-Local', {
  env: {
    account: '640664844884',
    region: 'eu-west-1'
  },
  instanceId: youtrackStack.instance.instanceId,
});
```

**Step 2: Verify TypeScript compiles**

```bash
npm run build
```

Expected output:
```
> onecloud@0.1.0 build
> tsc

(No errors)
```

**Step 3: Verify CDK synth works**

```bash
npx cdk synth
```

Expected output: CloudFormation templates for YouTrackStack-Local and AutomationStack-Local (no PipelineStack)

**Step 4: Commit the change**

```bash
git add bin/youtrack-app.ts
git commit -m "refactor: remove PipelineStack from application entry point"
```

Expected output:
```
[main XXXXXXX] refactor: remove PipelineStack from application entry point
 1 file changed, X insertions(+), X deletions(-)
```

---

## Task 5: Update CLAUDE.md - Project Overview

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update Project Overview section**

Find this line in CLAUDE.md (around line 5):
```markdown
The infrastructure uses a GitOps workflow with a self-mutating CDK pipeline for automated deployment. Infrastructure changes are pushed to CodeCommit, triggering automatic deployment via AWS CodePipeline.
```

Replace with:
```markdown
The infrastructure is deployed manually from a local development workstation using AWS CDK. All source code is stored in GitHub to comply with One.Cloud regulations requiring compliant source code providers.
```

**Step 2: Verify change**

```bash
grep -n "GitHub to comply with One.Cloud" CLAUDE.md
```

Expected: Line number showing the new text

---

## Task 6: Update CLAUDE.md - Development Commands

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Remove "Initial Pipeline Deployment" section**

Delete lines containing:
- `### Initial Pipeline Deployment (One-Time Setup)` (entire section including all bash commands until next ### heading)

**Step 2: Remove "Normal GitOps Workflow" section**

Delete lines containing:
- `### Normal GitOps Workflow (After Initial Setup)` (entire section until next ### heading)

**Step 3: Update remaining Development Commands section**

Replace the content under `## Development Commands` with:

```markdown
## Development Commands

### CDK Deployment

**Deploy both stacks:**
```bash
cdk deploy YouTrackStack-Local AutomationStack-Local
```

**Deploy individual stack:**
```bash
cdk deploy YouTrackStack-Local
```

**If SSL/CA certificate errors occur:**
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 cdk deploy YouTrackStack-Local AutomationStack-Local
```

**Note:** SSL certificate validation issues may occur due to Zscaler proxy. Use the `NODE_TLS_REJECT_UNAUTHORIZED=0` workaround if you encounter certificate errors.

### Local Development and Testing

```bash
# Synthesize CloudFormation template (for validation)
cdk synth

# Run tests
npm test

# Watch mode
npm run watch
```

### Emergency Manual Deployment

**Destroy stack (use with extreme caution):**
```bash
cdk destroy YouTrackStack-Local
```
```

**Step 4: Commit changes**

```bash
git add CLAUDE.md
git commit -m "docs: update Development Commands section for local deployment"
```

---

## Task 7: Update CLAUDE.md - Remove Pipeline Architecture

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Remove "Pipeline Architecture" section**

Delete the entire section starting with `## Pipeline Architecture` including all subsections:
- GitOps Workflow
- All content about CodeCommit, CodePipeline, self-mutation, etc.

**Step 2: Commit changes**

```bash
git add CLAUDE.md
git commit -m "docs: remove Pipeline Architecture section"
```

---

## Task 8: Update CLAUDE.md - Update Architecture Section

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update "Stack Structure" subsection**

Find the `### Stack Structure` section and replace with:

```markdown
### Stack Structure

The infrastructure consists of two CDK stacks deployed manually from the local workstation:

**1. YouTrackStack** (`lib/youtrack-stack.ts`) - Deployed locally
- EC2 t3.medium instance in eu-west-1a (4GB RAM required - t3.small causes OOM)
- Amazon Linux 2 from image factory (ami-0b434d403262ef6c7)
- Docker container running YouTrack from ECR
- Separate 50GB gp3 EBS data volume mounted at `/var/youtrack-data`
- Volume tagged `Backup: weekly-dlm` for automated snapshots
- Private IP only, port 8080
- SSM Session Manager access (no SSH)

**2. AutomationStack** (`lib/automation-stack.ts`) - Deployed locally
- EventBridge Scheduler for EC2 start/stop (Mon-Fri 7AM-7PM UTC)
- DLM lifecycle policy for weekly EBS snapshots (Friday 6PM UTC, 4 weeks retention)

**Key Components:**
- `SharedVpc`: Imported from `@vwg-community/vws-cdk` (required by SCP)
- Security Group: Allows inbound 8080 from RFC 1918 private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- IAM Role: SSM managed instance core + ECR read permissions
- UserData: Installs Docker, authenticates to ECR, runs YouTrack container with volume mount
```

**Step 2: Commit changes**

```bash
git add CLAUDE.md
git commit -m "docs: update Stack Structure to reflect local deployment"
```

---

## Task 9: Update CLAUDE.md - Current Deployment Section

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update Current Deployment section**

Find `## Current Deployment` section and update:

Change from:
```markdown
**Migration Status:** Infrastructure migrated to GitOps workflow on 2026-04-15

**Deployment Method:** Automated via CDK Pipeline
- Pipeline Stack: `PipelineStack`
- Application Stacks: `YouTrackStack`, `AutomationStack` (deployed by pipeline)
- Repository: CodeCommit `youtrack-infrastructure`
```

To:
```markdown
**Migration Status:** Infrastructure migrated from CodeCommit to GitHub on 2026-04-27

**Deployment Method:** Manual CDK deployment from local workstation
- Application Stacks: `YouTrackStack-Local`, `AutomationStack-Local`
- Repository: GitHub `https://github.com/vwChumbo/YouTrack.git`

**Compliance Note:** GitHub is used as the source code provider to comply with One.Cloud regulations. CodeCommit is not permitted for source code storage.
```

**Step 2: Remove PipelineStack references**

Search for any remaining mentions of "PipelineStack", "CodeCommit", "CodePipeline" in the Current Deployment section and remove them.

**Step 3: Commit changes**

```bash
git add CLAUDE.md
git commit -m "docs: update Current Deployment section for GitHub migration"
```

---

## Task 10: Final Verification and Push

**Files:**
- No file changes (verification only)

**Step 1: Verify no PipelineStack references remain**

```bash
grep -i "pipelinestack\|codecommit\|codepipeline" CLAUDE.md
```

Expected: No output (or only references in deprecated/historical context)

**Step 2: Verify TypeScript compiles**

```bash
npm run build
```

Expected: No errors

**Step 3: Verify CDK synth works**

```bash
npx cdk synth
```

Expected: CloudFormation templates for YouTrackStack-Local and AutomationStack-Local only

**Step 4: Check git status**

```bash
git status
```

Expected output:
```
On branch main
Your branch is ahead of 'origin/main' by X commits.
nothing to commit, working tree clean
```

**Step 5: Push all changes to GitHub**

```bash
git push origin main
```

Expected output:
```
Enumerating objects: X, done.
...
To https://github.com/vwChumbo/YouTrack.git
   XXXXXXX..YYYYYYY  main -> main
```

**Step 6: Verify production stacks still operational**

```bash
aws cloudformation describe-stacks --stack-name YouTrackStack-Local --region eu-west-1 --query 'Stacks[0].StackStatus' --output text
```

Expected: `CREATE_COMPLETE` or `UPDATE_COMPLETE`

```bash
aws cloudformation describe-stacks --stack-name AutomationStack-Local --region eu-west-1 --query 'Stacks[0].StackStatus' --output text
```

Expected: `CREATE_COMPLETE` or `UPDATE_COMPLETE`

---

## Success Criteria Checklist

After completing all tasks, verify:

- [x] Code successfully pushed to GitHub
- [x] Local git only has GitHub remote (codecommit removed)
- [x] PipelineStack destroyed in AWS
- [x] Pipeline code moved to `deprecated/pipeline/`
- [x] `bin/youtrack-app.ts` updated (no PipelineStack references)
- [x] CLAUDE.md updated with new workflow
- [x] All changes committed and pushed to GitHub
- [x] YouTrackStack-Local and AutomationStack-Local remain operational
- [x] TypeScript compiles without errors
- [x] CDK synth works without errors

---

## Rollback Plan

If something goes wrong during migration:

**Before Task 2 (destroying PipelineStack):**
- Re-add codecommit remote: `git remote add codecommit codecommit::eu-west-1://youtrack-infrastructure`
- Push to CodeCommit: `git push codecommit main`

**After Task 2 (PipelineStack destroyed):**
- GitHub is now the source of truth
- Redeploy PipelineStack from local machine if needed: `cdk deploy PipelineStack`
- Production stacks are never affected by this migration
