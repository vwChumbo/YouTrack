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
  // Instance ID hardcoded due to Lambda SCP restrictions (no CustomResource)
  // Update this if instance is replaced
  instanceId: 'i-0535d4cb73b266680',
});
