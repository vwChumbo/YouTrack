#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { YouTrackStack } from '../lib/youtrack-stack';

const app = new cdk.App();
new YouTrackStack(app, 'YouTrackStack', {
  env: {
    account: '640664844884',
    region: 'eu-west-1'
  },
});
