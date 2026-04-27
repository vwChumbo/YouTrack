# CodeCommit to GitHub Migration Design

**Date:** 2026-04-27  
**Status:** Approved  
**Migration Approach:** Sequential Safe Migration

## Context

Volkswagen One.Cloud internal regulations require source code to be stored in compliant source code providers. CodeCommit is not compliant. The infrastructure must migrate to GitHub while preserving production data and removing all non-compliant CI/CD infrastructure.

## Current State

**Infrastructure:**
- `YouTrackStack-Local` - Production stack with running EC2 instance (i-0591fecf34c1b50ca)
- `AutomationStack-Local` - EC2 scheduling and EBS backup automation
- `PipelineStack` - CodeCommit-based CI/CD pipeline (non-compliant, must be removed)

**Data Safety:**
- EBS data volume: 50GB at `/dev/sdf` (vol-0959de1b8294c8e9b)
- DLM backups: Working, 2 recent snapshots (April 17, April 24)
- Backup tag: `Backup: weekly-dlm`

**Repository:**
- Current: CodeCommit (`youtrack-infrastructure`)
- Target: GitHub (`https://github.com/vwChumbo/YouTrack.git`)

## Migration Strategy

**Approach:** Sequential Safe Migration

This approach prioritizes safety by:
1. Establishing GitHub as the source of truth before destroying AWS resources
2. Providing clear rollback points at each step
3. Verifying each phase before proceeding to the next

## Design Sections

### 1. Repository Migration

**Objective:** Move source code from CodeCommit to GitHub and update local git configuration.

**Steps:**

1. Add GitHub remote and push existing code:
   ```bash
   git remote add origin https://github.com/vwChumbo/YouTrack.git
   git branch -M main
   git push -u origin main
   ```

2. Verify GitHub has the code by checking the repository in browser

3. Remove CodeCommit remote from local git:
   ```bash
   git remote remove codecommit
   ```

4. Verify final git configuration:
   ```bash
   git remote -v
   # Should only show 'origin' pointing to GitHub
   ```

**Data Safety:** No production data is affected - this only moves the infrastructure code repository. The YouTrackStack-Local EC2 instance and EBS volume remain untouched.

**Rollback:** If something goes wrong, we can re-add the codecommit remote since PipelineStack still exists at this point.

### 2. Infrastructure Cleanup (Destroy PipelineStack)

**Objective:** Remove the CodeCommit-based CI/CD infrastructure that's no longer compliant.

**Steps:**

1. Destroy the PipelineStack via CDK:
   ```bash
   NODE_TLS_REJECT_UNAUTHORIZED=0 cdk destroy PipelineStack
   ```

2. Confirm destruction by checking CloudFormation:
   ```bash
   aws cloudformation list-stacks --region eu-west-1 \
     --stack-status-filter DELETE_COMPLETE \
     --query 'StackSummaries[?StackName==`PipelineStack`]'
   ```

**What gets deleted:**
- CodeCommit repository (`youtrack-infrastructure`)
- CodePipeline pipeline (`YouTrackInfrastructurePipeline`)
- CodeBuild projects (synth and self-mutation)
- IAM roles and policies created by the pipeline
- All associated CloudFormation resources

**What stays intact:**
- ✅ YouTrackStack-Local (production EC2 + data volume)
- ✅ AutomationStack-Local (schedules + DLM backups)
- ✅ All EBS snapshots (they're independent of the stack)

**Note:** Non-Local stacks (YouTrackStack, AutomationStack) do not exist, so no additional cleanup is needed.

### 3. Code Cleanup

**Objective:** Remove pipeline code from the repository and update the application entry point.

**Steps:**

1. Move pipeline code to deprecated directory:
   ```bash
   mkdir -p deprecated/pipeline
   git mv lib/pipeline-stack.ts deprecated/pipeline/
   ```

2. Update `bin/youtrack-app.ts` to remove PipelineStack:
   - Remove the `import { PipelineStack } from '../lib/pipeline-stack';` line
   - Remove the PipelineStack instantiation (lines 9-15)
   - Keep only YouTrackStack-Local and AutomationStack-Local

3. Final app structure:
   ```typescript
   #!/usr/bin/env node
   import * as cdk from 'aws-cdk-lib';
   import { YouTrackStack } from '../lib/youtrack-stack';
   import { AutomationStack } from '../lib/automation-stack';
   
   const app = new cdk.App();
   
   // YouTrack deployment for local deployment
   const youtrackStack = new YouTrackStack(app, 'YouTrackStack-Local', {
     env: { account: '640664844884', region: 'eu-west-1' }
   });
   
   new AutomationStack(app, 'AutomationStack-Local', {
     env: { account: '640664844884', region: 'eu-west-1' },
     instanceId: youtrackStack.instance.instanceId,
   });
   ```

**Result:** Clean repository with only the active infrastructure code, pipeline code preserved in `deprecated/` for reference.

### 4. Documentation Update (CLAUDE.md)

**Objective:** Update CLAUDE.md to reflect the new GitHub + local deployment workflow, removing all CodeCommit/Pipeline references.

**Sections to remove:**
- "Initial Pipeline Deployment (One-Time Setup)" - entire section
- "Normal GitOps Workflow (After Initial Setup)" - entire section
- "Pipeline Architecture" - entire section including GitOps Workflow subsection
- All references to CodeCommit repository and pipeline in other sections

**Sections to update:**

1. **Project Overview** - Change from:
   - ~~"GitOps workflow with self-mutating CDK pipeline"~~
   - To: "Local CDK deployment from development workstation"

2. **Development Commands** - Simplify to:
   ```bash
   # Deploy both stacks
   cdk deploy YouTrackStack-Local AutomationStack-Local
   
   # Deploy individual stack
   cdk deploy YouTrackStack-Local
   
   # If SSL/CA certificate errors occur, use workaround:
   NODE_TLS_REJECT_UNAUTHORIZED=0 cdk deploy YouTrackStack-Local AutomationStack-Local
   
   # Destroy stack (emergency only)
   cdk destroy YouTrackStack-Local
   ```

3. **Current Deployment** section - Update:
   - Deployment Method: ~~"Automated via CDK Pipeline"~~ → "Manual CDK deployment from local workstation"
   - Repository: ~~"CodeCommit `youtrack-infrastructure`"~~ → "GitHub: https://github.com/vwChumbo/YouTrack.git"
   - Remove all Pipeline Stack references

4. **Architecture / Stack Structure** - Update to show only:
   - YouTrackStack-Local
   - AutomationStack-Local
   - Remove PipelineStack entirely

**Additions:**
- Add note about GitHub being the compliant source code provider per One.Cloud regulations
- Add SSL workaround note: "If certificate errors occur, prefix commands with `NODE_TLS_REJECT_UNAUTHORIZED=0`"
- Update git workflow section to reflect GitHub as the primary remote

## Success Criteria

- [ ] Code successfully pushed to GitHub
- [ ] Local git only has GitHub remote (codecommit removed)
- [ ] PipelineStack destroyed in AWS
- [ ] Pipeline code moved to `deprecated/pipeline/`
- [ ] `bin/youtrack-app.ts` updated (no PipelineStack references)
- [ ] CLAUDE.md updated with new workflow
- [ ] All changes committed and pushed to GitHub
- [ ] YouTrackStack-Local and AutomationStack-Local remain operational
- [ ] EBS backups continue working

## Risks and Mitigations

**Risk:** GitHub push fails after removing CodeCommit remote  
**Mitigation:** Verify GitHub push succeeds before removing codecommit remote

**Risk:** Accidental destruction of production stacks  
**Mitigation:** Only destroy PipelineStack by name, never use wildcard patterns

**Risk:** Data loss during migration  
**Mitigation:** EBS snapshots are recent (April 24) and independent of infrastructure changes

**Risk:** SSL/TLS certificate errors during CDK destroy  
**Mitigation:** Use `NODE_TLS_REJECT_UNAUTHORIZED=0` prefix if needed

## Post-Migration Workflow

**Normal development workflow:**
1. Make infrastructure changes locally
2. Test with `cdk synth` to validate
3. Deploy with `cdk deploy YouTrackStack-Local AutomationStack-Local`
4. Commit changes to git
5. Push to GitHub: `git push origin main`

**No CI/CD automation** - all deployments are manual from the local workstation.

## Timeline

This is a single-session migration:
1. Repository migration: ~5 minutes
2. Infrastructure cleanup: ~10 minutes (stack deletion time)
3. Code cleanup: ~5 minutes
4. Documentation update: ~15 minutes
5. Final commit and push: ~2 minutes

**Total estimated time:** ~40 minutes
