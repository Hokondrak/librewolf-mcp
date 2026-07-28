import type { NativeMessageWriter } from './framing.js';
import type { MessagePipe } from './types.js';

export async function relayMessages(
  extensionMessages: AsyncIterable<unknown>,
  extensionWriter: NativeMessageWriter,
  pipe: MessagePipe,
): Promise<void> {
  let closing = false;
  const fromExtension = async (): Promise<void> => {
    for await (const message of extensionMessages) {
      if (isPing(message)) {
        await extensionWriter.write({
          jsonrpc: '2.0',
          method: 'host.pong',
          params: { at: new Date().toISOString() },
        });
        continue;
      }
      await pipe.send(message);
    }
  };
  const fromPipe = async (): Promise<void> => {
    while (!closing) {
      const message = await pipe.receive();
      if (message === null) return;
      await extensionWriter.write(message);
    }
  };

  const extensionTask = fromExtension();
  const pipeTask = fromPipe();
  try {
    await Promise.race([extensionTask, pipeTask]);
  } finally {
    closing = true;
    await pipe.close();
    await Promise.allSettled([extensionTask, pipeTask]);
  }
}

function isPing(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)['method'] === 'extension.ping'
  );
}
