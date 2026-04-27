# Deployment Execution Design

**Date:** 2026-04-27  
**Type:** Update Deployment (Instance Replacement)  
**Risk Level:** HIGH  
**Expected Downtime:** 10-15 minutes

## Context

This deployment executes the "Update Deployment Procedure" from the deployment checklist to apply pending KMS encryption changes to the YouTrack infrastructure. The CDK diff shows that the EC2 instance will be replaced due to changes in the root volume encryption configuration (adding customer-managed KMS key).

**Why this change is being made:**
- Implement customer-managed KMS encryption for all EBS volumes (root and data)
- Improve security posture by having full control over encryption keys
- Enable key rotation and granular access control via KMS key policies
- Comply with best practices for encryption at rest

**What prompted it:**
- Recent security compliance work documented in commits b71f379 through 58e4e7f
- Addition of comprehensive deployment checklist for safe infrastructure changes
- Need to apply tested security improvements to production infrastructure

**Intended outcome:**
- YouTrack infrastructure running with customer-managed KMS encryption
- All volumes encrypted with alias/youtrack-ebs-encryption key
- Instance replacement completed successfully with zero data loss
- Documentation updated to reflect new instance ID and configuration

## Deployment Approach

Execute the "Update Deployment Procedure" (Section starting at line 352 of deployment-checklist.md) sequentially with full automation, following these phases:

### Phase 1: Pre-Deployment Validation

**Code and Environment Checks:**
1. Commit pending changes to deployment-checklist.md
2. Verify git working tree is clean
3. Run `cdk synth --all` to validate templates
4. Confirm AWS credentials (account 640664844884, eu-west-1)
5. Verify network access to AWS services

**State Backup:**
1. Capture current stack outputs to `/tmp/youtrack-stack-before.json`
2. Document current instance ID: i-0591fecf34c1b50ca
3. Identify data volume ID (vol-0959de1b8294c8e9b from checklist)
4. Record latest backup snapshot ID (snap-0933904884299fbc5 from checklist)

**Manual Snapshot Creation:**
1. Get data volume ID from AWS
2. Create snapshot with description "Pre-deployment snapshot 2026-04-27"
3. Wait for snapshot state to reach "completed"
4. Record snapshot ID for potential rollback

**Risk Assessment:**
1. Run `cdk diff YouTrackStack-Local` to confirm changes
2. Verify instance replacement is expected (due to BlockDeviceMappings change)
3. Confirm data volume will be detached/reattached (not replaced)

**Validation Gates:**
- Git must be clean (no uncommitted changes)
- CDK synth must succeed without errors
- Snapshot must complete before proceeding
- CDK diff must show only expected KMS-related changes

### Phase 2: Deployment Execution

**Deployment Steps:**
1. Execute `cdk deploy YouTrackStack-Local`
   - Use `NODE_TLS_REJECT_UNAUTHORIZED=0` if SSL certificate errors occur
2. Monitor CloudFormation events in real-time
3. Expected resource sequence:
   - Create AWS::KMS::Key (YouTrackEbsKey)
   - Create AWS::KMS::Alias (alias/youtrack-ebs-encryption)
   - Create AWS::EC2::LaunchTemplate
   - Replace AWS::EC2::Instance (terminate old i-0591fecf34c1b50ca, create new)
   - Update AWS::EC2::Volume (add KmsKeyId to data volume)
4. Track progress: CREATE_IN_PROGRESS → CREATE_COMPLETE for each resource

**Expected Duration:** 10-15 minutes

**Failure Handling:**
- If deployment fails: CloudFormation auto-rollback should restore previous state
- If rollback fails: Present user with options (retry, manual rollback, restore from snapshot)
- Critical errors halt execution and await user decision

### Phase 3: Post-Deployment Validation

**Infrastructure Validation:**
1. Extract new stack outputs (instance ID, private IP, KMS key ID)
2. Verify new instance state is "running"
3. Confirm IMDSv2 enforcement: `HttpTokens=required`
4. Validate root volume encryption (30GB, gp3, encrypted with KMS key)
5. Validate data volume encryption (50GB, gp3, encrypted with KMS key)
6. Verify data volume attached to new instance (state: in-use)
7. Confirm data volume backup tag present: `Backup: weekly-dlm`

**Application Validation:**
1. Connect via SSM Session Manager to new instance
2. Run `docker ps` - verify youtrack container running
3. Run `docker logs youtrack | tail -20` - check for startup success
4. Verify `/var/youtrack-data/` directory exists and is mounted
5. Check permissions: `ls -la /var/youtrack-data/` (should be 13001:13001)
6. Exit SSM session

**UI Access Test:**
1. Start SSM port forwarding (8080 → localhost:8484)
2. Open browser to http://localhost:8484
3. Verify YouTrack UI loads
4. Test login with existing credentials
5. Confirm projects and issues are visible (data integrity check)
6. Stop port forwarding session

**Security Validation:**
1. Verify no public IP assigned to instance
2. Confirm security group rules unchanged (RFC 1918 ranges only)
3. Validate KMS key policy includes ec2.amazonaws.com and dlm.amazonaws.com principals
4. Check all volumes show encrypted=true with correct KMS key ARN

**Pass Criteria:**
- All validation steps must pass before marking deployment successful
- Any failure requires investigation and resolution
- Data integrity is critical - projects/issues must be accessible

### Phase 4: Documentation and Cleanup

**Update Documentation:**
1. Update `CLAUDE.md` "Current Deployment" section:
   - New instance ID (captured from stack outputs)
   - New private IP (captured from stack outputs)
   - New KMS key ID (captured from stack outputs)
   - Update deployment date to 2026-04-27
2. Commit deployment-checklist.md changes (if modified)
3. Commit CLAUDE.md with message: "docs: update instance ID after deployment"
4. Push commits to GitHub

**Record Deployment:**
- Old instance ID: i-0591fecf34c1b50ca
- New instance ID: (to be captured)
- Manual snapshot ID: (to be captured)
- Deployment timestamp: (to be captured)
- Any issues encountered: (to be documented)

**Cleanup:**
- Manual snapshot retained for 24-48 hours as safety net
- User can delete manually later if desired
- Weekly DLM backups continue automatically

**Final Checks:**
1. All documentation committed and pushed to GitHub
2. Instance still running after validation
3. Automated start/stop schedules will work (EventBridge uses stack output reference)
4. DLM policy will continue backing up data volume (tag-based targeting)

## Critical Files

**Infrastructure Code:**
- `lib/youtrack-stack.ts` - Stack definition with KMS key configuration
- `lib/automation-stack.ts` - EventBridge schedules (reference instance via stack output)
- `cdk.json` - CDK configuration

**Documentation:**
- `CLAUDE.md` - Primary project documentation (will be updated with new instance ID)
- `docs/deployment-checklist.md` - Deployment procedures (being executed)
- `docs/plans/2026-04-27-deployment-execution-design.md` - This design document

**Git:**
- Must commit any pending changes before deployment
- Must update CLAUDE.md after successful deployment
- All changes pushed to GitHub

## Verification Plan

**End-to-End Test:**
1. Instance is running
2. All volumes encrypted with customer-managed KMS key
3. Docker container healthy and serving traffic
4. YouTrack UI accessible via SSM port forwarding
5. Can login and view existing data
6. Data persists after container restart (if needed for testing)

**Rollback Plan:**
If critical issues occur during or after deployment:

**Option 1: CloudFormation Rollback (Preferred)**
- AWS Console → CloudFormation → YouTrackStack-Local → Stack Actions → Roll back
- CloudFormation reverts to previous stable state
- Validate old instance (i-0591fecf34c1b50ca) is restored

**Option 2: Restore from Snapshot**
- Stop new instance
- Detach data volume
- Create new volume from manual snapshot
- Attach new volume to instance
- Start instance and verify data

**Option 3: Redeploy from Git**
- Checkout previous commit (before KMS changes)
- Run `npm run build && cdk deploy YouTrackStack-Local`
- Validate deployment and data integrity

## Success Metrics

- [ ] Stack status: UPDATE_COMPLETE
- [ ] New instance running with IMDSv2 enforced
- [ ] All volumes encrypted with customer-managed KMS key
- [ ] Data volume attached with backup tag
- [ ] Docker container running
- [ ] YouTrack UI accessible
- [ ] Existing data visible and intact
- [ ] CLAUDE.md updated with new instance details
- [ ] No errors in CloudWatch logs
- [ ] Downtime within expected 10-15 minutes

## Risk Mitigation

**High Risk: Instance Replacement**
- Mitigation: Manual snapshot before deployment
- Validation: Data volume detach/reattach process tested in diff
- Rollback: Multiple options available (CloudFormation, snapshot restore, git redeploy)

**Medium Risk: Data Volume Encryption Update**
- Mitigation: Volume not replaced, only KmsKeyId property added
- Validation: Backup tag preserved, attachment maintained
- Impact: Minimal - volume remains intact, only metadata updated

**Low Risk: Documentation Drift**
- Mitigation: Automated documentation update in deployment plan
- Validation: Git commit required before marking complete
- Impact: Minimal - can be corrected post-deployment if missed
