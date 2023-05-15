import cloneDeep from "clone-deep";
import dedent from "dedent";
import execa from "execa";
import log from "npmlog";
import os from "os";
import { performance } from "perf_hooks";
import { PackageGraph } from "../package-graph";
import { CommandConfigOptions, Project } from "../project";
import { ValidationError } from "../validation-error";
import { writeLogFile } from "../write-log-file";
import { cleanStack } from "./clean-stack";
import { defaultOptions } from "./default-options";
import { logPackageError } from "./log-package-error";
import { warnIfHanging } from "./warn-if-hanging";

const DEFAULT_CONCURRENCY = os.cpus().length;

export class Command<T extends CommandConfigOptions = CommandConfigOptions> {
  name: string;
  composed: boolean;
  options: T = {} as T;
  runner: Promise<unknown>;
  concurrency?: number;
  toposort = false;
  execOpts?: { cwd: string; maxBuffer?: number };
  packageGraph?: PackageGraph;
  logger!: log.Logger;

  private _project?: Project;
  get project(): Project {
    if (this._project === undefined) {
      throw new ValidationError("ENOPROJECT", "Lerna Project not initialized!");
    }
    return this._project;
  }

  set project(project: Project) {
    this._project = project;
  }

  constructor(_argv: any, { skipValidations } = { skipValidations: false }) {
    performance.mark("command:start");
    log.pause();
    log.heading = "lerna";

    const argv = cloneDeep(_argv);
    log.silly("argv", argv);

    // "FooCommand" => "foo"
    this.name = this.constructor.name.replace(/Command$/, "").toLowerCase();

    // composed commands are called from other commands, like publish -> version
    this.composed = typeof argv.composed === "string" && argv.composed !== this.name;

    if (!this.composed) {
      // composed commands have already logged the lerna version
      log.notice("cli", `v${argv.lernaVersion}`);
    }

    // launch the command
    let runner = new Promise((resolve, reject) => {
      // run everything inside a Promise chain
      let chain = Promise.resolve();

      chain = chain.then(() => {
        performance.mark("command:buildProject:start");
        this.project = new Project(argv.cwd);
        performance.mark("command:buildProject:end");
        performance.measure("command buildProject", "command:buildProject:start", "command:buildProject:end");
      });
      chain = chain.then(() => this.configureEnvironment());
      chain = chain.then(() => this.configureOptions());
      chain = chain.then(() => this.configureProperties());
      chain = chain.then(() => this.configureLogging());
      // For the special "repair" command we want to initialize everything but don't want to run validations as that will end up becoming cyclical
      if (!skipValidations) {
        chain = chain.then(() => this.runValidations());
      }
      chain = chain.then(() => this.runPreparations());
      chain = chain.then(() => this.runCommand());

      chain.then(
        (result) => {
          performance.mark("command:end");
          performance.measure("command", "command:start", "command:end");
          warnIfHanging();

          resolve(result);
        },
        (err) => {
          if (err.pkg) {
            // Cleanly log specific package error details
            logPackageError(err, this.options.stream);
          } else if (err.name !== "ValidationError") {
            // npmlog does some funny stuff to the stack by default,
            // so pass it directly to avoid duplication.
            log.error("", cleanStack(err, this.constructor.name));
          }

          // ValidationError does not trigger a log dump, nor do external package errors
          if (err.name !== "ValidationError" && !err.pkg) {
            writeLogFile(this.project.rootPath);
          }

          warnIfHanging();

          // error code is handled by cli.fail()
          reject(err);
        }
      );
    });

    // passed via yargs context in tests, never actual CLI
    /* istanbul ignore else */
    if (argv.onResolved || argv.onRejected) {
      runner = runner.then(argv.onResolved, argv.onRejected);

      // when nested, never resolve inner with outer callbacks
      delete argv.onResolved; // eslint-disable-line no-param-reassign
      delete argv.onRejected; // eslint-disable-line no-param-reassign
    }

    // "hide" irrelevant argv keys from options
    for (const key of ["cwd", "$0"]) {
      Object.defineProperty(argv, key, { enumerable: false });
    }

    Object.defineProperty(this, "argv", {
      value: Object.freeze(argv),
    });

    this.runner = runner;
  }

  // proxy "Promise" methods to "private" instance
  then(onResolved: () => void, onRejected: (err: string | Error) => void) {
    return this.runner.then(onResolved, onRejected);
  }

  /* istanbul ignore next */
  catch(onRejected: (err: string | Error) => void) {
    return this.runner.catch(onRejected);
  }

  get requiresGit() {
    return true;
  }

  // Override this to inherit config from another command.
  // For example `changed` inherits config from `publish`.
  get otherCommandConfigs() {
    return [];
  }

  configureEnvironment() {
    performance.mark("command:configure-environment:start");
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const ci = require("is-ci");
    let loglevel;
    let progress;

    /* istanbul ignore next */
    if (ci || !process.stderr.isTTY) {
      log.disableColor();
      progress = false;
    } else if (!process.stdout.isTTY) {
      // stdout is being piped, don't log non-errors or progress bars
      progress = false;
      loglevel = "error";
    } else if (process.stderr.isTTY) {
      log.enableColor();
      log.enableUnicode();
    }

    Object.defineProperty(this, "envDefaults", {
      value: {
        ci,
        progress,
        loglevel,
      },
    });
    performance.mark("command:configure-environment:end");
    performance.measure(
      "command configureEnvironment",
      "command:configure-environment:start",
      "command:configure-environment:end"
    );
  }

  configureOptions() {
    performance.mark("command:configure-options:start");

    // Command config object normalized to "command" namespace
    const commandConfig = this.project.config.command || {};

    // The current command always overrides otherCommandConfigs
    const overrides = [this.name, ...this.otherCommandConfigs].map((key) => commandConfig[key]);

    this.options = defaultOptions(
      // CLI flags, which if defined overrule subsequent values
      this.argv,
      // Namespaced command options from `lerna.json`
      ...overrides,
      // Global options from `lerna.json`
      this.project.config,
      // Environmental defaults prepared in previous step
      this.envDefaults
    );

    if (this.options.verbose && this.options.loglevel !== "silly") {
      this.options.loglevel = "verbose";
    }

    performance.mark("command:configure-options:end");
    performance.measure(
      "command configureOptions",
      "command:configure-options:start",
      "command:configure-options:end"
    );
  }
  argv(argv: any, arg1: any, config: any, envDefaults: any): any {
    throw new Error("Method not implemented.");
  }
  envDefaults(argv: any, arg1: any, config: any, envDefaults: any): any {
    throw new Error("Method not implemented.");
  }

  configureProperties() {
    performance.mark("command:configure-properties:start");

    const { concurrency = 0, sort, maxBuffer } = this.options;
    this.concurrency = Math.max(1, +concurrency || DEFAULT_CONCURRENCY);
    this.toposort = sort === undefined || sort;

    /** @type {import("@lerna/child-process").ExecOpts} */
    this.execOpts = {
      cwd: this.project.rootPath,
      maxBuffer,
    };

    performance.mark("command:configure-properties:end");
    performance.measure(
      "command configureProperties",
      "command:configure-properties:start",
      "command:configure-properties:end"
    );
  }

  configureLogging() {
    performance.mark("command:configure-logging:start");

    const { loglevel } = this.options;

    if (loglevel) {
      log.level = loglevel;
    }

    // handle log.success()
    log.addLevel("success", 3001, { fg: "green", bold: true });

    // create logger that subclasses use
    Object.defineProperty(this, "logger", {
      value: log["newGroup"](this.name),
    });

    // emit all buffered logs at configured level and higher
    log.resume();

    performance.mark("command:configure-logging:end");
    performance.measure(
      "command configureLogging",
      "command:configure-logging:start",
      "command:configure-logging:end"
    );
  }

  enableProgressBar() {
    /* istanbul ignore next */
    if (this.options.progress !== false) {
      log.enableProgress();
    }
  }

  gitInitialized() {
    const opts: execa.SyncOptions = {
      cwd: this.project.rootPath,
      // don't throw, just want boolean
      reject: false,
      // only return code, no stdio needed
      stdio: "ignore",
    };

    return execa.sync("git", ["rev-parse"], opts).exitCode === 0;
  }

  runValidations() {
    performance.mark("command:run-validations:start");

    if ((this.options.since !== undefined || this.requiresGit) && !this.gitInitialized()) {
      throw new ValidationError("ENOGIT", "The git binary was not found, or this is not a git repository.");
    }

    if (!this.project.manifest) {
      throw new ValidationError("ENOPKG", "`package.json` does not exist, have you run `lerna init`?");
    }

    if (this.project.configNotFound) {
      throw new ValidationError("ENOLERNA", "`lerna.json` does not exist, have you run `lerna init`?");
    }

    if (!this.project.version) {
      throw new ValidationError("ENOVERSION", "Required property version does not exist in `lerna.json`");
    }

    if (this.options.independent && !this.project.isIndependent()) {
      throw new ValidationError(
        "EVERSIONMODE",
        dedent`
          You ran lerna with --independent or -i, but the repository is not set to independent mode.
          To use independent mode you need to set lerna.json's "version" property to "independent".
          Then you won't need to pass the --independent or -i flags.
        `
      );
    }

    if (this.options.npmClient === "pnpm" && !this.options.useWorkspaces) {
      throw new ValidationError(
        "ENOWORKSPACES",
        "Usage of pnpm without workspaces is not supported. To use pnpm with lerna, set useWorkspaces to true in lerna.json and configure pnpm to use workspaces: https://pnpm.io/workspaces."
      );
    }

    performance.mark("command:run-validations:end");
    performance.measure(
      "command runValidations",
      "command:run-validations:start",
      "command:run-validations:end"
    );
  }

  runPreparations() {
    performance.mark("command:run-preparations:start");

    if (!this.composed && this.project.isIndependent()) {
      // composed commands have already logged the independent status
      log.info("versioning", "independent");
    }

    if (!this.composed && this.options.ci) {
      log.info("ci", "enabled");
    }

    let chain = Promise.resolve();

    // TODO: refactor to address type issues
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    chain = chain.then(() => this.project.getPackages());
    chain = chain.then((packages) => {
      // TODO: refactor to address type issues
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      this.packageGraph = new PackageGraph(packages);
      performance.mark("command:run-preparations:end");
      performance.measure(
        "command runPreparations",
        "command:run-preparations:start",
        "command:run-preparations:end"
      );
    });

    return chain;
  }

  runCommand(): Promise<void> {
    return Promise.resolve()
      .then(() => {
        performance.mark("command:initialize:start");
      })
      .then(() => this.initialize())
      .then((proceed) => {
        performance.mark("command:initialize:end");
        performance.measure("command initialize", "command:initialize:start", "command:initialize:end");
        return proceed;
      })
      .then((proceed) => {
        performance.mark("command:execute:start");
        // TODO: refactor to address type issues
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        if (proceed !== false) {
          return this.execute();
        }

        // early exits set their own exitCode (if non-zero)
      })
      .then((_) => {
        performance.mark("command:execute:end");
        performance.measure("command execute", "command:execute:start", "command:execute:end");
        return _;
      });
  }

  initialize() {
    throw new ValidationError(this.name, "initialize() needs to be implemented.");
  }

  execute() {
    throw new ValidationError(this.name, "execute() needs to be implemented.");
  }
}
