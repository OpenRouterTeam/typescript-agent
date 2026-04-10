/**
 * Shared test constants for model identifiers.
 *
 * Unit/integration tests use a synthetic placeholder so they never
 * depend on a real model existing. Change these in one place if the
 * convention needs to be updated.
 */

/** Default model identifier used in non-e2e tests. */
export const TEST_MODEL = 'openai/gpt-4.1-nano';

/** Alternative model for tests that need a second, distinct model. */
export const TEST_MODEL_ALT = 'openai/gpt-4.1-mini';
