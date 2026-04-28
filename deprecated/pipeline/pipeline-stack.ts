import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as pipelines from 'aws-cdk-lib/pipelines';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { SharedVpc } from '@vwg-community/vws-cdk';
import { YouTrackStack } from '../../lib/youtrack-stack';
import { AutomationStack } from '../../lib/automation-stack';

export class PipelineStack extends cdk.Stack {
  public readonly repository: codecommit.Repository;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Add compliance tags
    cdk.Tags.of(this).add('Environment', 'production');
    cdk.Tags.of(this).add('Project', 'YouTrack');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Owner', 'a2i5giv');
    cdk.Tags.of(this).add('Purpose', 'CI-CD-Pipeline');

    // Import Shared VPC (required by SCP)
    const sharedVpc = new SharedVpc(this, 'SharedVpc');

    // Create CodeCommit repository
    this.repository = new codecommit.Repository(this, 'YouTrackRepository', {
      repositoryName: 'youtrack-infrastructure',
      description: 'AWS CDK infrastructure for YouTrack issue tracking deployment',
    });

    // Create CDK Pipeline
    const pipeline = new pipelines.CodePipeline(this, 'Pipeline', {
      pipelineName: 'YouTrackInfrastructurePipeline',
      synth: new pipelines.CodeBuildStep('Synth', {
        input: pipelines.CodePipelineSource.codeCommit(this.repository, 'main'),
        commands: [
          'npm ci',
          'npm run build',
          'npx cdk synth',
        ],
        buildEnvironment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        },
        vpc: sharedVpc.vpc,
        subnetSelection: {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      }),
      selfMutation: true,
      // Configure self-mutation CodeBuild project to use VPC (One.Cloud SCP requirement)
      selfMutationCodeBuildDefaults: {
        vpc: sharedVpc.vpc,
        subnetSelection: {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
        buildEnvironment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        },
      },
    });

    // Add deploy stage to pipeline
    pipeline.addStage(new ApplicationStage(this, 'Deploy', {
      env: props?.env,
    }));

    // Stack outputs
    new cdk.CfnOutput(this, 'RepositoryCloneUrlHttp', {
      value: this.repository.repositoryCloneUrlHttp,
      description: 'CodeCommit repository clone URL (HTTP)',
      exportName: 'YouTrackRepositoryCloneUrlHttp',
    });

    new cdk.CfnOutput(this, 'RepositoryArn', {
      value: this.repository.repositoryArn,
      description: 'CodeCommit repository ARN',
      exportName: 'YouTrackRepositoryArn',
    });

    new cdk.CfnOutput(this, 'RepositoryName', {
      value: this.repository.repositoryName,
      description: 'CodeCommit repository name',
    });
  }
}

/**
 * Application Stage that instantiates application stacks for deployment
 */
class ApplicationStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props?: cdk.StageProps) {
    super(scope, id, props);

    // Instantiate YouTrackStack
    const youTrackStack = new YouTrackStack(this, 'YouTrackStack', {
      env: props?.env,
    });

    // Instantiate AutomationStack with instance ID from YouTrackStack
    new AutomationStack(this, 'AutomationStack', {
      env: props?.env,
      // instanceId looked up at deploy time
    });
  }
}
