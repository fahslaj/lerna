import log from "npmlog";
import { execPackageManager, spawnPackageManagerStreaming } from "./corepack";
import { getNpmExecOpts } from "./get-npm-exec-opts";

export function npmRunScript(script: string, { args, npmClient, pkg, reject = true }: any) {
  log.silly("npmRunScript", script, args, pkg.name);

  const argv = ["run", script, ...args];
  const opts = makeOpts(pkg, reject);

  return execPackageManager(npmClient, argv, opts);
}

export function npmRunScriptStreaming(script: string, { args, npmClient, pkg, prefix, reject = true }: any) {
  log.silly("npmRunScriptStreaming", [script, args, pkg.name]);

  const argv = ["run", script, ...args];
  const opts = makeOpts(pkg, reject);

  return spawnPackageManagerStreaming(npmClient, argv, opts, prefix && pkg.name);
}

function makeOpts(pkg: { name: any; location: string }, reject: any) {
  return Object.assign(getNpmExecOpts(pkg), {
    windowsHide: false,
    reject,
  });
}
