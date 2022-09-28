import * as fs from 'fs';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Architecture } from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';
import { Bundling, BundlingOptions } from './bundling';
import { LockFile } from './package-manager';
import { findUpMultiple } from './util';
import type { NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';

/**
 * Properties for a NodejsFunction
 */
export interface NestjsFunctionProps extends NodejsFunctionProps {
  /**
   * NestJS monorepo project to build.
   */
  readonly project?: string;


  /**
   * Bundling options
   *
   */
  readonly bundling?: BundlingOptions;
}

/**
 * A Node.js Lambda function bundled using esbuild
 */
export class NestjsFunction extends lambda.Function {
  constructor(scope: Construct, id: string, props: NestjsFunctionProps = {}) {
    if (props.runtime && props.runtime.family !== lambda.RuntimeFamily.NODEJS) {
      throw new Error('Only `NODEJS` runtimes are supported.');
    }

    // Entry and defaults
    const handler = props.handler ?? 'handler';
    const runtime = props.runtime ?? lambda.Runtime.NODEJS_14_X;
    const architecture = props.architecture ?? Architecture.X86_64;
    const depsLockFilePath = findLockFile(props.depsLockFilePath);
    const projectRoot = props.projectRoot ?? path.dirname(depsLockFilePath);
    const entry = props.entry ?? path.resolve(`${projectRoot}/dist/apps/${props.project}/main.js`);

    super(scope, id, {
      ...props,
      runtime,
      code: Bundling.bundle({
        ...props.bundling ?? {},
        project: props.project,
        entry,
        runtime,
        architecture,
        depsLockFilePath,
        projectRoot,
      }),
      handler: `main.${handler}`,
    });

    // Enable connection reuse for aws-sdk
    if (props.awsSdkConnectionReuse ?? true) {
      this.addEnvironment('AWS_NODEJS_CONNECTION_REUSE_ENABLED', '1', { removeInEdge: true });
    }
  }
}

/**
 * Checks given lock file or searches for a lock file
 */
function findLockFile(depsLockFilePath?: string): string {
  if (depsLockFilePath) {
    if (!fs.existsSync(depsLockFilePath)) {
      throw new Error(`Lock file at ${depsLockFilePath} doesn't exist`);
    }

    if (!fs.statSync(depsLockFilePath).isFile()) {
      throw new Error('`depsLockFilePath` should point to a file');
    }

    return path.resolve(depsLockFilePath);
  }

  const lockFiles = findUpMultiple([
    LockFile.PNPM,
    LockFile.YARN,
    LockFile.NPM,
  ]);

  if (lockFiles.length === 0) {
    throw new Error('Cannot find a package lock file (`pnpm-lock.yaml`, `yarn.lock` or `package-lock.json`). Please specify it with `depsLockFilePath`.');
  }
  if (lockFiles.length > 1) {
    throw new Error(`Multiple package lock files found: ${lockFiles.join(', ')}. Please specify the desired one with \`depsLockFilePath\`.`);
  }

  return lockFiles[0];
}
