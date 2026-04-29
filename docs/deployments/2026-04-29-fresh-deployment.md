# Fresh YouTrack Deployment - 2026-04-29

## Summary
Complete redeployment of YouTrack infrastructure from scratch after previous deployment failed due to incomplete volume persistence.

## Root Cause of Previous Failure
- Only `/opt/youtrack/data` was mounted to EBS volume
- Missing `/opt/youtrack/conf` caused configuration loss on instance replacement
- YouTrack Docker image declares 4 volumes that must all be persisted:
  - `/opt/youtrack/data` (database)
  - `/opt/youtrack/conf` (configuration)
  - `/opt/youtrack/logs` (logs)
  - `/opt/youtrack/backups` (internal backups)

## Changes Made
- All 4 YouTrack volumes now properly mounted as subdirectories
- Added customer-managed KMS keys for EBS and CloudWatch Logs
- Schedule updated to 08:00-19:00 UTC (Lisbon time approximation)
- Added YouTrack internal backup cron (daily 2AM UTC)
- Added CloudWatch log group with encryption and 1-year retention
- DLM backup changed to 19:30 UTC Friday (after instance stop)
- Removed snapshot-based volume creation (fresh start)

## Instance Details
- **Instance ID**: i-0535d4cb73b266680
- **Private IP**: 192.168.148.21
- **EBS KMS Key**: e70778f4-cced-4312-a192-03cbfdf5c4e0
- **Logs KMS Key**: Check CloudFormation outputs (alias/youtrack-logs-encryption)
- **Stack Name**: YouTrackStack-Local
- **VPC ID**: vpc-05b5078f709cfc904
- **Availability Zone**: eu-west-1a
- **Region**: eu-west-1
- **Account**: 640664844884

## Verification Completed
- [x] Instance running with IMDSv2 enforced
- [x] All volumes encrypted with customer-managed KMS key
- [x] Docker container running with 4 volume mounts
- [x] CloudWatch log group created with encryption and 1-year retention
- [x] YouTrack setup wizard completed
- [x] AutomationStack deployed (EventBridge schedules and DLM policy)
- [x] DLM backup policy configured (Friday 19:30 UTC, 4-week retention)
- [x] YouTrack internal backup cron configured (daily 02:00 UTC)

## Volume Configuration
- **Root Volume**: 30GB gp3, encrypted with customer-managed KMS
- **Data Volume**: 50GB gp3, encrypted with customer-managed KMS
- **Mount Point**: `/var/youtrack-data`
- **Subdirectories**: 
  - `/var/youtrack-data/data` → `/opt/youtrack/data`
  - `/var/youtrack-data/conf` → `/opt/youtrack/conf`
  - `/var/youtrack-data/logs` → `/opt/youtrack/logs`
  - `/var/youtrack-data/backups` → `/opt/youtrack/backups`
- **Backup Tag**: `Backup: weekly-dlm`

## Automation Configuration
- **Start Schedule**: Monday-Friday at 08:00 UTC
- **Stop Schedule**: Monday-Friday at 19:00 UTC
- **DLM Backup**: Friday at 19:30 UTC (4-week retention)
- **YouTrack Internal Backup**: Daily at 02:00 UTC (via cron)

## Security Configuration
- **IMDSv2**: Enforced (requireImdsv2: true)
- **Network**: PRIVATE_ISOLATED subnet, no public IP
- **Security Group**: Port 8080 from RFC 1918 private ranges only
- **Access Method**: SSM Session Manager only (no SSH)
- **Encryption at Rest**: All volumes encrypted with customer-managed KMS
- **Encryption in Transit**: CloudWatch Logs encrypted with customer-managed KMS
- **KMS Key Rotation**: Enabled (annual automatic)

## Rollback Plan
If issues occur:
1. Document the issue thoroughly
2. Delete stacks: `cdk destroy AutomationStack-Local YouTrackStack-Local --force`
3. Revert code changes: `git revert <commit-hash>`
4. Redeploy from previous stable commit

## Next Steps
1. Monitor first scheduled start (Monday morning 08:00 UTC)
2. Monitor first scheduled stop (Monday evening 19:00 UTC)
3. Verify first DLM backup (Friday 19:30 UTC)
4. Verify YouTrack internal backup (check `/var/youtrack-data/backups` after 02:00 UTC)
5. Test restore procedure from EBS snapshot (within 1 month)
6. Monitor CloudWatch Logs for SSM session activity
7. Validate KMS key rotation after 1 year

## Cost Estimate
- **EC2 t3.medium**: ~$7/month (75% reduction due to scheduling)
- **EBS 50GB gp3**: ~$4/month
- **EBS snapshots**: ~$2/month (incremental, 4 weeks retention)
- **CloudWatch Logs**: <$1/month (SSM session logs, 1-year retention)
- **KMS keys**: $2/month (2 keys: EBS + Logs)
- **Total**: ~$15-16/month (vs ~$36/month without automation)

## Lessons Learned
1. **Volume Persistence**: Docker VOLUME directives in upstream images must ALL be mounted to persistent storage
2. **Configuration Loss**: Missing `/opt/youtrack/conf` causes complete configuration loss on instance replacement
3. **Testing**: Always verify all 4 volume mounts with `docker inspect` after deployment
4. **Documentation**: Document all required volumes in CLAUDE.md for future reference
5. **Verification**: Test SSM port forwarding and YouTrack UI access before considering deployment complete

## References
- Implementation Plan: `docs/plans/2026-04-28-fresh-youtrack-deployment.md`
- Code Changes: Commits from 2026-04-28 to 2026-04-29
- Documentation: `CLAUDE.md` updated with new instance details
