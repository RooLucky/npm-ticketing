export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}
