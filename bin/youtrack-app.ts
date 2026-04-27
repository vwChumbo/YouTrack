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
