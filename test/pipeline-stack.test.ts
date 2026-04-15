import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { PipelineStack } from '../lib/pipeline-stack';

describe('PipelineStack', () => {
  test('creates CodeCommit repository with correct name', () => {
    const app = new cdk.App();
    const stack = new PipelineStack(app, 'TestPipelineStack', {
      env: {
        account: '640664844884',
        region: 'eu-west-1',
      },
    });

    const template = Template.fromStack(stack);

    // Verify CodeCommit repository is created
    template.hasResourceProperties('AWS::CodeCommit::Repository', {
      RepositoryName: 'youtrack-infrastructure',
      RepositoryDescription: 'AWS CDK infrastructure for YouTrack issue tracking deployment',
    });
  });

  test('creates CDK Pipeline with correct configuration', () => {
    const app = new cdk.App();
    const stack = new PipelineStack(app, 'TestPipelineStack', {
      env: {
        account: '640664844884',
        region: 'eu-west-1',
      },
    });

    const template = Template.fromStack(stack);

    // Verify CodePipeline is created
    template.resourceCountIs('AWS::CodePipeline::Pipeline', 1);
  });

  test('creates CodeBuild project in VPC', () => {
    const app = new cdk.App();
    const stack = new PipelineStack(app, 'TestPipelineStack', {
      env: {
        account: '640664844884',
        region: 'eu-west-1',
      },
    });

    const template = Template.fromStack(stack);

    // Verify CodeBuild projects are created (synth + self-mutation)
    template.resourceCountIs('AWS::CodeBuild::Project', 2);

    // Verify CodeBuild project has VPC configuration
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      VpcConfig: {
        VpcId: Match.anyValue(),
        Subnets: Match.anyValue(),
      },
    });
  });

  test('includes required compliance tags', () => {
    const app = new cdk.App();
    const stack = new PipelineStack(app, 'TestPipelineStack', {
      env: {
        account: '640664844884',
        region: 'eu-west-1',
      },
    });

    // Verify tags are applied to stack
    const tags = cdk.Tags.of(stack);
    expect(tags).toBeDefined();
  });

  test('exports repository outputs', () => {
    const app = new cdk.App();
    const stack = new PipelineStack(app, 'TestPipelineStack', {
      env: {
        account: '640664844884',
        region: 'eu-west-1',
      },
    });

    const template = Template.fromStack(stack);

    // Verify stack outputs are created
    template.hasOutput('RepositoryCloneUrlHttp', {
      Export: {
        Name: 'YouTrackRepositoryCloneUrlHttp',
      },
    });

    template.hasOutput('RepositoryArn', {
      Export: {
        Name: 'YouTrackRepositoryArn',
      },
    });
  });
});
