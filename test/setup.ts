import { Assertion, should } from 'vitest';

should(); // Initialize should assertion style

declare global {
  interface Object {
    should: Assertion;
  }
}
