import { spawn } from 'node:child_process';

const ALLOWED_COMMANDS = new Set([
  'rev-parse',
  'symbolic-ref',
  'for-each-ref',
  'rev-list',
  'log',
  'diff-tree',
  'version',
]);

const READ_ONLY_ENV = Object.freeze({
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
});

export class GitCommandError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GitCommandError';
    Object.assign(this, details);
  }
}

function validateArguments(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new TypeError('Git arguments must be a non-empty array');
  }
  if (args.some((argument) => typeof argument !== 'string' || argument.includes('\0'))) {
    throw new TypeError('Git arguments must be NUL-free strings');
  }
  if (!ALLOWED_COMMANDS.has(args[0])) {
    throw new GitCommandError(`Git command is not allowed: ${args[0]}`, {
      code: 'GIT_COMMAND_NOT_ALLOWED',
      command: args[0],
    });
  }
  if (args[0] === 'version' && args.length !== 1) {
    throw new GitCommandError('git version does not accept arguments', {
      code: 'GIT_ARGUMENT_NOT_ALLOWED',
      command: args[0],
    });
  }
  if (args[0] === 'symbolic-ref') {
    const symbolicArguments = args.slice(1);
    const positional = symbolicArguments.filter((argument) => !argument.startsWith('-'));
    const invalidOption = symbolicArguments.find(
      (argument) => argument.startsWith('-') && argument !== '--quiet' && argument !== '-q' &&
        argument !== '--short',
    );
    if (positional.length !== 1 || invalidOption) {
      throw new GitCommandError('symbolic-ref is restricted to read-only queries', {
        code: 'GIT_ARGUMENT_NOT_ALLOWED',
        command: args[0],
      });
    }
  }
  if ((args[0] === 'log' || args[0] === 'diff-tree') &&
      args.slice(1).some((argument) => argument === '--output' || argument.startsWith('--output='))) {
    throw new GitCommandError(`${args[0]} --output is not allowed`, {
      code: 'GIT_ARGUMENT_NOT_ALLOWED',
      command: args[0],
    });
  }
}

export function createGitRunner(defaults = {}) {
  const defaultTimeoutMs = defaults.timeoutMs ?? 30_000;
  const defaultMaxOutputBytes = defaults.maxOutputBytes ?? 64 * 1024 * 1024;

  return function runGit(cwd, args, options = {}) {
    validateArguments(args);

    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    const maxOutputBytes = options.maxOutputBytes ?? defaultMaxOutputBytes;
    const allowedExitCodes = new Set(options.allowedExitCodes ?? [0]);

    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be a positive safe integer');
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      throw new RangeError('maxOutputBytes must be a positive safe integer');
    }

    return new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd,
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          ...defaults.env,
          ...options.env,
          ...READ_ONLY_ENV,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stdout = [];
      const stderr = [];
      let outputBytes = 0;
      let settled = false;
      let terminationError;

      const terminate = (error) => {
        if (terminationError) return;
        terminationError = error;
        child.kill('SIGKILL');
      };

      const collect = (target) => (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          terminate(new GitCommandError(`Git output exceeded ${maxOutputBytes} bytes`, {
            code: 'GIT_OUTPUT_LIMIT',
            args: [...args],
            maxOutputBytes,
          }));
          return;
        }
        target.push(chunk);
      };

      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));

      const timer = setTimeout(() => {
        terminate(new GitCommandError(`Git command timed out after ${timeoutMs}ms`, {
          code: 'GIT_TIMEOUT',
          args: [...args],
          timeoutMs,
        }));
      }, timeoutMs);
      timer.unref();

      child.once('error', (cause) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new GitCommandError(`Unable to start git ${args[0]}: ${cause.message}`, {
          code: 'GIT_SPAWN_ERROR',
          args: [...args],
          cause,
        }));
      });

      child.once('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        const result = {
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode,
          signal,
        };

        if (terminationError) {
          Object.assign(terminationError, result);
          reject(terminationError);
          return;
        }
        if (!allowedExitCodes.has(exitCode)) {
          reject(new GitCommandError(
            `git ${args[0]} exited with code ${exitCode}: ${result.stderr.toString('utf8').trim()}`,
            { code: 'GIT_EXIT_ERROR', args: [...args], ...result },
          ));
          return;
        }
        resolve(result);
      });

      if (options.input === undefined || options.input === null) {
        child.stdin.end();
      } else {
        child.stdin.end(options.input);
      }
    });
  };
}

export const runGit = createGitRunner();
export { ALLOWED_COMMANDS, READ_ONLY_ENV };
