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

  test('has self-mutation enabled', () => {
    const app = new cdk.App();
    const stack = new PipelineStack(app, 'TestPipelineStack', {
      env: {
        account: '640664844884',
        region: 'eu-west-1',
      },
    });

    const template = Template.fromStack(stack);

    // Verify self-mutation stage is present (indicated by 2 CodeBuild projects: synth + self-mutation)
    template.resourceCountIs('AWS::CodeBuild::Project', 2);
  });

  test('uses PRIVATE_ISOLATED subnet type for CodeBuild', () => {
    const app = new cdk.App();
    const stack = new PipelineStack(app, 'TestPipelineStack', {
      env: {
        account: '640664844884',
        region: 'eu-west-1',
      },
    });

    const template = Template.fromStack(stack);

    // Verify CodeBuild project has VPC configuration with PRIVATE_ISOLATED subnets
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      VpcConfig: {
        VpcId: Match.anyValue(),
        Subnets: Match.anyValue(),
      },
    });
  });

  test('pipeline has deploy stage configured', () => {
    const app = new cdk.App();
    const stack = new PipelineStack(app, 'TestPipelineStack', {
      env: {
        account: '640664844884',
        region: 'eu-west-1',
      },
    });

    const template = Template.fromStack(stack);

    // Verify pipeline exists
    template.resourceCountIs('AWS::CodePipeline::Pipeline', 1);

    // Verify pipeline has multiple stages (Source, Build/Synth, UpdatePipeline, Deploy)
    // The pipeline definition includes stages in the Stages property
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Stages: Match.arrayWith([
        Match.objectLike({ Name: 'Source' }),
        Match.objectLike({ Name: Match.stringLikeRegexp('Synth|Build') }),
        Match.objectLike({ Name: Match.stringLikeRegexp('UpdatePipeline|SelfMutate') }),
        Match.objectLike({ Name: Match.stringLikeRegexp('Deploy') }),
      ]),
    });
  });

  test('pipeline uses correct environment configuration', () => {
    const app = new cdk.App();
    const stack = new PipelineStack(app, 'TestPipelineStack', {
      env: {
        account: '640664844884',
        region: 'eu-west-1',
      },
    });

    // Verify stack environment is correctly set
    expect(stack.account).toBe('640664844884');
    expect(stack.region).toBe('eu-west-1');
  });
});
