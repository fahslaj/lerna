import { ExecOptions } from "child_process";
import { ExecaReturnValue } from "execa";
import log from "npmlog";
import { isCorepackEnabled } from "./is-corepack-enabled";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const childProcess = require("@lerna/child-process");

function createCommandAndArgs(npmClient: string, args: string[]) {
  let command = npmClient;
  const commandArgs = [...args];

  if (isCorepackEnabled()) {
    commandArgs.unshift(command);
    command = "corepack";
  }

  return { command, commandArgs };
}

export function execPackageManager(
  npmClient: string,
  args: string[],
  opts: ExecOptions
): Promise<ExecaReturnValue<string>> {
  const { command, commandArgs } = createCommandAndArgs(npmClient, args);
  log.silly("execPackageManager", command, commandArgs);
  return childProcess.exec(command, commandArgs, opts);
}

export function execPackageManagerSync(npmClient: string, args: string[], opts: ExecOptions): string {
  const { command, commandArgs } = createCommandAndArgs(npmClient, args);
  log.silly("execPackageManagerSync", command, commandArgs);
  return childProcess.execSync(command, commandArgs, opts);
}

export function spawnPackageManagerStreaming(
  npmClient: string,
  args: string[],
  opts: ExecOptions,
  prefix?: string
) {
  const { command, commandArgs } = createCommandAndArgs(npmClient, args);
  log.silly("spawnPackageManagerStreaming", command, commandArgs);
  return childProcess.spawnStreaming(command, commandArgs, opts, prefix);
}
