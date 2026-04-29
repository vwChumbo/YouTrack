#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { KeyStack } from '@vwg-community/vws-cdk';
import { BootstrapStack } from '../lib/stacks/bootstrap-stack';
import { YouTrackStack } from '../lib/youtrack-stack';
import { AutomationStack } from '../lib/automation-stack';

const app = new cdk.App();

const account = '640664844884';

// Deploy KeyStack and BootstrapStack in eu-west-1 only (generic account infrastructure)
// Note: us-east-1 skipped due to SCP restrictions preventing S3 bucket deletion
const keyStack = new KeyStack(app, 'KeyStack-eu-west-1', {
  stackName: 'KeyStack-eu-west-1',
  env: { account, region: 'eu-west-1' },
});

const bootstrapStack = new BootstrapStack(app, 'BootstrapStack-eu-west-1', {
  stackName: 'BootstrapStack-eu-west-1',
  env: { account, region: 'eu-west-1' },
});
bootstrapStack.addDependency(keyStack);

// Deploy application stacks in eu-west-1 only
// Note: YouTrackStack will use KeyStack.getKeyFromLookup() to find deployed keys
const youtrackStack = new YouTrackStack(app, 'YouTrackStack', {
  stackName: 'YouTrackStack',
  env: { account, region: 'eu-west-1' },
});

// AutomationStack manages scheduling and backups for YouTrack instance
const automationStack = new AutomationStack(app, 'AutomationStack', {
  stackName: 'AutomationStack',
  env: { account, region: 'eu-west-1' },
  instanceId: 'i-07f47d6f9108e5bb6',  // Updated 2026-04-29 after fresh deployment
});
automationStack.addDependency(youtrackStack);
