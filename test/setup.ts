import { Assertion, should } from 'vitest';

should(); // Initialize should assertion style

declare global {
// Interface (not type) is required here: this augments the built-in global
// `Object` interface via declaration merging. A type alias would shadow it.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Object {
    should: Assertion;
  }
}
