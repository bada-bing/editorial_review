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
  constructor(what: string, id: string | number) {
    super("NotFound", `no ${what} with id ${id}`);
  }
}

/** The text is not in the state the action needs. */
export class NotYourTurn extends CoreError {
  constructor(action: string, state: string) {
    super("NotYourTurn", `cannot ${action} while the text is ${state}`);
  }
}

export class TextApproved extends CoreError {
  constructor(id: string) {
    super("TextApproved", `text ${id} is approved and accepts no change`);
  }
}

/** A requested review is still open, so the draft it reads must not change. */
export class ReviewRunning extends CoreError {
  constructor(id: string) {
    super("ReviewRunning", `a review of text ${id} is still running`);
  }
}

/** The request does not fit the draft: a line outside it, or a reply to a comment not on it. */
export class Invalid extends CoreError {
  constructor(message: string) {
    super("Invalid", message);
  }
}

export class NotApproved extends CoreError {
  constructor(id: string, state: string) {
    super("NotApproved", `text ${id} is ${state}, not approved`);
  }
}

/** The actor may not take this action; today, an agent trying what is mine. */
export class Forbidden extends CoreError {
  constructor(action: string) {
    super("Forbidden", `an agent may not ${action}`);
  }
}
