// Erros esperados (de usuario ou de ambiente). A CLI imprime so a mensagem,
// em uma linha, sem stack trace.
export class DevslimError extends Error {
  exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'DevslimError';
    this.exitCode = exitCode;
  }
}

// Uso incorreto da CLI (flag desconhecida, argumento faltando): exit 2.
export class UsageError extends DevslimError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'UsageError';
  }
}
