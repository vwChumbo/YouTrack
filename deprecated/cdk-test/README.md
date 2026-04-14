# CDK Test Stack (DEPRECATED)

This directory contains the initial CDK test stack used to validate AWS CDK deployment in the One.Cloud environment.

**Status:** ✅ Completed and validated
**Date:** 2026-04-14
**Purpose:** Learn CDK, One.Cloud SCPs, and VPC Lambda deployment

See `TESTING-RESULTS.md` for complete documentation of challenges and solutions.

**Key Learnings:**
- Lambda functions MUST run in VPC (SCP requirement)
- Use SharedVpc from @vwg-community/vws-cdk
- BucketDeployment and autoDeleteObjects create Lambda functions without VPC config
- PRIVATE_ISOLATED subnet type required

This code is preserved for reference but should not be deployed.
