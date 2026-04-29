import { IAspect, CfnResource } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';
import { CfnRole } from 'aws-cdk-lib/aws-iam';

/**
 * CDK Aspect that adds STS actions to all IAM role trust policies.
 * Required for VWS Developer Role to assume CDK-created roles.
 *
 * Adds: sts:SetSourceIdentity and sts:TagSession
 */
export class AddStsActionsToTrustPolicyAspect implements IAspect {
  public visit(node: IConstruct): void {
    if (node instanceof CfnRole) {
      const assumeRolePolicy = node.assumeRolePolicyDocument as any;

      if (assumeRolePolicy && assumeRolePolicy.Statement) {
        const statements = Array.isArray(assumeRolePolicy.Statement)
          ? assumeRolePolicy.Statement
          : [assumeRolePolicy.Statement];

        statements.forEach((statement: any) => {
          if (statement.Action) {
            const actions = Array.isArray(statement.Action)
              ? statement.Action
              : [statement.Action];

            // Add STS actions if not already present
            if (actions.includes('sts:AssumeRole')) {
              const stsActions = ['sts:SetSourceIdentity', 'sts:TagSession'];
              stsActions.forEach(action => {
                if (!actions.includes(action)) {
                  actions.push(action);
                }
              });
              statement.Action = actions;
            }
          }
        });
      }
    }
  }
}
