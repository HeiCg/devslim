// Expected errors (user or environment). The CLI prints only the message,
// on one line, without a stack trace.
export class DevslimError extends Error {
  exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'DevslimError';
    this.exitCode = exitCode;
  }
}

// Incorrect CLI usage (unknown flag, missing argument): exit 2.
export class UsageError extends DevslimError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'UsageError';
  }
}
