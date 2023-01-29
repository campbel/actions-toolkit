import fs from 'fs';
import path from 'path';
import * as exec from '@actions/exec';
import {parse} from 'csv-parse/sync';
import * as semver from 'semver';

import {Docker} from './docker';
import {Context} from './context';

export interface BuildxOpts {
  context: Context;
  standalone?: boolean;
}

export class Buildx {
  private readonly context: Context;
  public standalone: boolean;
  public version: Promise<string>;

  constructor(opts: BuildxOpts) {
    this.context = opts.context;
    this.standalone = opts?.standalone ?? !Docker.isAvailable();
    this.version = this.getVersion();
  }

  public getCommand(args: Array<string>) {
    return {
      command: this.standalone ? 'buildx' : 'docker',
      args: this.standalone ? args : ['buildx', ...args]
    };
  }

  public async isAvailable(): Promise<boolean> {
    const cmd = this.getCommand([]);
    return await exec
      .getExecOutput(cmd.command, cmd.args, {
        ignoreReturnCode: true,
        silent: true
      })
      .then(res => {
        if (res.stderr.length > 0 && res.exitCode != 0) {
          return false;
        }
        return res.exitCode == 0;
      })
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .catch(error => {
        return false;
      });
  }

  private async getVersion(): Promise<string> {
    const cmd = this.getCommand(['version']);
    return await exec
      .getExecOutput(cmd.command, cmd.args, {
        ignoreReturnCode: true,
        silent: true
      })
      .then(res => {
        if (res.stderr.length > 0 && res.exitCode != 0) {
          throw new Error(res.stderr.trim());
        }
        return Buildx.parseVersion(res.stdout.trim());
      });
  }

  public async printVersion() {
    const cmd = this.getCommand(['version']);
    await exec.exec(cmd.command, cmd.args, {
      failOnStdErr: false
    });
  }

  public static parseVersion(stdout: string): string {
    const matches = /\sv?([0-9a-f]{7}|[0-9.]+)/.exec(stdout);
    if (!matches) {
      throw new Error(`Cannot parse buildx version`);
    }
    return matches[1];
  }

  public async versionSatisfies(range: string, version?: string): Promise<boolean> {
    const ver = version ?? (await this.version);
    return semver.satisfies(ver, range) || /^[0-9a-f]{7}$/.exec(ver) !== null;
  }

  public getBuildImageIDFilePath(): string {
    return path.join(this.context.tmpDir(), 'iidfile').split(path.sep).join(path.posix.sep);
  }

  public getBuildMetadataFilePath(): string {
    return path.join(this.context.tmpDir(), 'metadata-file').split(path.sep).join(path.posix.sep);
  }

  public getBuildImageID(): string | undefined {
    const iidFile = this.getBuildImageIDFilePath();
    if (!fs.existsSync(iidFile)) {
      return undefined;
    }
    return fs.readFileSync(iidFile, {encoding: 'utf-8'}).trim();
  }

  public getBuildMetadata(): string | undefined {
    const metadataFile = this.getBuildMetadataFilePath();
    if (!fs.existsSync(metadataFile)) {
      return undefined;
    }
    const content = fs.readFileSync(metadataFile, {encoding: 'utf-8'}).trim();
    if (content === 'null') {
      return undefined;
    }
    return content;
  }

  public getDigest(): string | undefined {
    const metadata = this.getBuildMetadata();
    if (metadata === undefined) {
      return undefined;
    }
    const metadataJSON = JSON.parse(metadata);
    if (metadataJSON['containerimage.digest']) {
      return metadataJSON['containerimage.digest'];
    }
    return undefined;
  }

  public generateBuildSecretString(kvp: string): string {
    return this.generateBuildSecret(kvp, false);
  }

  public generateBuildSecretFile(kvp: string): string {
    return this.generateBuildSecret(kvp, true);
  }

  public generateBuildSecret(kvp: string, file: boolean): string {
    const delimiterIndex = kvp.indexOf('=');
    const key = kvp.substring(0, delimiterIndex);
    let value = kvp.substring(delimiterIndex + 1);
    if (key.length == 0 || value.length == 0) {
      throw new Error(`${kvp} is not a valid secret`);
    }
    if (file) {
      if (!fs.existsSync(value)) {
        throw new Error(`secret file ${value} not found`);
      }
      value = fs.readFileSync(value, {encoding: 'utf-8'});
    }
    const secretFile = this.context.tmpName({tmpdir: this.context.tmpDir()});
    fs.writeFileSync(secretFile, value);
    return `id=${key},src=${secretFile}`;
  }

  public static hasLocalExporter(exporters: string[]): boolean {
    return Buildx.hasExporterType('local', exporters);
  }

  public static hasTarExporter(exporters: string[]): boolean {
    return Buildx.hasExporterType('tar', exporters);
  }

  public static hasDockerExporter(exporters: string[], load?: boolean): boolean {
    return load ?? Buildx.hasExporterType('docker', exporters);
  }

  public static hasExporterType(name: string, exporters: string[]): boolean {
    const records = parse(exporters.join(`\n`), {
      delimiter: ',',
      trim: true,
      columns: false,
      relaxColumnCount: true
    });
    for (const record of records) {
      if (record.length == 1 && !record[0].startsWith('type=')) {
        // Local if no type is defined
        // https://github.com/docker/buildx/blob/d2bf42f8b4784d83fde17acb3ed84703ddc2156b/build/output.go#L29-L43
        return name == 'local';
      }
      for (const [key, value] of record.map(chunk => chunk.split('=').map(item => item.trim()))) {
        if (key == 'type' && value == name) {
          return true;
        }
      }
    }
    return false;
  }

  public static hasGitAuthTokenSecret(secrets: string[]): boolean {
    for (const secret of secrets) {
      if (secret.startsWith('GIT_AUTH_TOKEN=')) {
        return true;
      }
    }
    return false;
  }
}
