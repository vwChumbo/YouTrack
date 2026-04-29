#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { KeyStack } from '../lib/stacks/key-stack';
import { BootstrapStack } from '../lib/stacks/bootstrap-stack';
import { YouTrackStack } from '../lib/youtrack-stack';
import { AutomationStack } from '../lib/automation-stack';

const app = new cdk.App();

const account = '640664844884';
const regions = ['eu-west-1', 'us-east-1'];

// Deploy KeyStack and BootstrapStack in both regions
regions.forEach(region => {
  const keyStack = new KeyStack(app, `KeyStack-Local-${region}`, {
    stackName: `YouTrackKeyStack-Local-${region}`,
    env: { account, region },
  });

  const bootstrapStack = new BootstrapStack(app, `BootstrapStack-Local-${region}`, {
    stackName: `YouTrackBootstrapStack-Local-${region}`,
    env: { account, region },
  });
  bootstrapStack.addDependency(keyStack);
});

// Deploy application stacks in eu-west-1 only
const keyStackEuWest1 = app.node.tryFindChild('KeyStack-Local-eu-west-1') as KeyStack;

const youtrackStack = new YouTrackStack(app, 'YouTrackStack-Local', {
  env: { account, region: 'eu-west-1' },
});
youtrackStack.addDependency(keyStackEuWest1);

// Note: Instance ID will be different after recreation - update after deployment
const automationStack = new AutomationStack(app, 'AutomationStack-Local', {
  env: { account, region: 'eu-west-1' },
  instanceId: 'PLACEHOLDER-UPDATE-AFTER-DEPLOYMENT',
});
automationStack.addDependency(youtrackStack);
