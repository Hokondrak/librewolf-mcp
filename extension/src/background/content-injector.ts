export class ContentInjector {
  readonly #documentIds = new Map<number, string>();

  constructor() {
    browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if ('url' in changeInfo || changeInfo['status'] === 'loading') {
        this.#documentIds.delete(tabId);
      }
    });
    browser.tabs.onRemoved.addListener((tabId) => this.#documentIds.delete(tabId));
  }

  async execute(tabId: number, message: unknown, frameId = 0): Promise<unknown> {
    await browser.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ['content/index.js'],
    });
    const response = await browser.tabs.sendMessage(tabId, message, { frameId });
    if (isContentResponse(response)) {
      const known = this.#documentIds.get(tabId);
      if (known && known !== response.documentId) {
        throw new StaleDocumentError(known, response.documentId);
      }
      this.#documentIds.set(tabId, response.documentId);
      if (isContentErrorResponse(response)) {
        throw new ContentOperationError(
          response.error.code,
          response.error.message,
          response.error.recoverable,
          response.error.details,
        );
      }
    }
    return response;
  }
}

export class StaleDocumentError extends Error {
  constructor(
    readonly expectedDocumentId: string,
    readonly actualDocumentId: string,
  ) {
    super('The page document changed. Take a new snapshot and retry with fresh UIDs.');
    this.name = 'StaleDocumentError';
  }
}

export class ContentOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recoverable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ContentOperationError';
  }
}

function isContentResponse(value: unknown): value is { documentId: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { documentId?: unknown }).documentId === 'string'
  );
}

function isContentErrorResponse(value: { documentId: string }): value is {
  documentId: string;
  ok: false;
  error: {
    code: string;
    message: string;
    recoverable: boolean;
    details?: Record<string, unknown>;
  };
} {
  const candidate = value as {
    ok?: unknown;
    error?: {
      code?: unknown;
      message?: unknown;
      recoverable?: unknown;
      details?: unknown;
    };
  };
  return (
    candidate.ok === false &&
    typeof candidate.error?.code === 'string' &&
    typeof candidate.error.message === 'string' &&
    typeof candidate.error.recoverable === 'boolean'
  );
}
