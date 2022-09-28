import * as os from 'os';
import * as path from 'path';
import { Architecture, AssetCode, Code, Runtime } from 'aws-cdk-lib/aws-lambda';
import * as cdk from 'aws-cdk-lib';
import { PackageManager } from './package-manager';
import { exec, extractDependencies, findUp } from './util';
import { LogLevel } from 'aws-cdk-lib/aws-lambda-nodejs';
import { dirname } from 'path';

export interface BundlingOptions {
  /**
   * Additional node modules to package along with the function
   */
   readonly nodeModules?: string[]
}

/**
 * Bundling properties
 */
export interface BundlingProps extends BundlingOptions {
  /**
   * Path to lock file
   */
  readonly depsLockFilePath: string;

  /**
   * NestJS monorepo project to build.
   */
  readonly project?: string;

  /**
  * Webpacked entry file, defaults to ./dsit/{project}/main.js
  */
  readonly entry: string;

  /**
   * The runtime of the lambda function
   */
  readonly runtime: Runtime;

  /**
   * The system architecture of the lambda function
   */
  readonly architecture: Architecture;

  /**
   * Path to project root
   */
  readonly projectRoot: string;

  /**
   * Log level for esbuild. This is also propagated to the package manager and
   * applies to its specific install command.
   *
   * @default LogLevel.WARNING
   */
   readonly logLevel?: LogLevel;
}

/**
 * Bundling with esbuild
 */
export class Bundling implements cdk.BundlingOptions {
  /**
   * esbuild bundled Lambda asset code
   */
  public static bundle(options: BundlingProps): AssetCode {
    return Code.fromAsset(options.projectRoot, {
      assetHashType: cdk.AssetHashType.OUTPUT,
      bundling: new Bundling(options),
    });
  }

  // Core bundling options
  public readonly image = cdk.DockerImage.fromRegistry('dummy');
  public readonly local?: cdk.ILocalBundling;

  private readonly projectRoot: string;
  private readonly relativeDepsLockFilePath: string;
  private readonly packageManager: PackageManager;

  constructor(private readonly props: BundlingProps) {
    this.projectRoot = this.props.projectRoot;
    this.relativeDepsLockFilePath = path.relative(this.projectRoot, path.resolve(props.depsLockFilePath));
    this.packageManager = PackageManager.fromLockFile(props.depsLockFilePath, props.logLevel);
    this.local = this.getLocalBundlingProvider();
  }

  private createBundlingCommand(options: BundlingCommandOptions): string {
    const pathJoin = osPathJoin(options.osPlatform);
    const osCommand = new OsCommand(options.osPlatform);
    let depsCommand = '';
    if (this.props.nodeModules) {
      // Find 'package.json' closest to entry folder, we are going to extract the
      // modules versions from it.
      const pkgPath = findUp('package.json', this.props.entry);
      if (!pkgPath) {
        throw new Error('Cannot find a `package.json` in this project. Using `nodeModules` requires a `package.json`.');
      }

      // Determine dependencies versions, lock file and installer
      const dependencies = extractDependencies(pkgPath, this.props.nodeModules);

      const lockFilePath = pathJoin(options.inputDir, this.relativeDepsLockFilePath ?? this.packageManager.lockFile);

      // Create dummy package.json, copy lock file if any and then install
      depsCommand = chain([
        osCommand.writeJson(pathJoin(options.outputDir, 'package.json'), { dependencies }),
        osCommand.copy(lockFilePath, pathJoin(options.outputDir, this.packageManager.lockFile)),
        osCommand.changeDirectory(options.outputDir),
        this.packageManager.installCommand.join(' '),
      ]);
    }

    const outdir = `"${pathJoin(dirname(this.props.entry))}"`
    return chain([
      `npx nest build ${this.props.project ?? ''} --webpack`,
      `cp -r ${pathJoin(outdir, "*")} "${options.outputDir}"`,
      depsCommand,
    ]);
  }

  private getLocalBundlingProvider(): cdk.ILocalBundling {
    const osPlatform = os.platform();
    const createLocalCommand = (outputDir: string) => this.createBundlingCommand({
      inputDir: this.projectRoot,
      outputDir,
      osPlatform,
    });
    const cwd = this.projectRoot;

    return {
      tryBundle(outputDir: string) {
        const localCommand = createLocalCommand(outputDir);
        console.log(localCommand)

        exec(
          osPlatform === 'win32' ? 'cmd' : 'bash',
          [
            osPlatform === 'win32' ? '/c' : '-c',
            localCommand,
          ],
          {
            stdio: [ // show output
              'ignore', // ignore stdio
              process.stderr, // redirect stdout to stderr
              'inherit', // inherit stderr
            ],
            cwd,
            windowsVerbatimArguments: osPlatform === 'win32',
          });

        return true;
      },
    };
  }
}

interface BundlingCommandOptions {
  readonly inputDir: string;
  readonly outputDir: string;
  readonly osPlatform: NodeJS.Platform;
}

/**
 * OS agnostic command
 */
class OsCommand {
  constructor(private readonly osPlatform: NodeJS.Platform) {}

  public writeJson(filePath: string, data: any): string {
    const stringifiedData = JSON.stringify(data);
    if (this.osPlatform === 'win32') {
      return `echo ^${stringifiedData}^ > "${filePath}"`;
    }

    return `echo '${stringifiedData}' > "${filePath}"`;
  }

  public copy(src: string, dest: string): string {
    if (this.osPlatform === 'win32') {
      return `copy "${src}" "${dest}"`;
    }

    return `cp "${src}" "${dest}"`;
  }

  public changeDirectory(dir: string): string {
    return `cd "${dir}"`;
  }
}

/**
 * Chain commands
 */
function chain(commands: string[]): string {
  return commands.filter(c => !!c).join(' && ');
}

/**
 * Platform specific path join
 */
function osPathJoin(platform: NodeJS.Platform) {
  return function(...paths: string[]): string {
    const joined = path.join(...paths);
    // If we are on win32 but need posix style paths
    if (os.platform() === 'win32' && platform !== 'win32') {
      return joined.replace(/\\/g, '/');
    }
    return joined;
  };
}
