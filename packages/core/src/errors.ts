/** A rule of the record, broken. `cli` turns one into a message and a non-zero exit. */
export class CoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = code;
  }
}

export class NotFound extends CoreError {
  constructor(what: string, id: number) {
    super("NotFound", `no ${what} with id ${id}`);
  }
}
