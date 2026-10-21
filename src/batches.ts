export const READ_BATCH_SIZE = 4;

// Settle the whole batch before yielding in input order. A consumer that throws
// closes the iterator before another batch starts, leaving no reads in flight.
export async function* settledInOrder<T, R>(inputs: readonly T[], read: (input: T) => Promise<R>) {
  for (let offset = 0; offset < inputs.length; offset += READ_BATCH_SIZE) {
    const batch = inputs.slice(offset, offset + READ_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(async input => read(input)));
    for (let i = 0; i < batch.length; i++) yield { input: batch[i], result: results[i] };
  }
}
