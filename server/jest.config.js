/**
 * Jest configuration for the LeadFlow server.
 *
 * Tests run against a REAL PostgreSQL database rather than a mocked one. The
 * routing logic is expressed largely in SQL — the round-robin least-loaded
 * query, the COALESCE that preserves an SLA deadline across reassignment, the
 * partial indexes — and a mocked data layer would assert that the mock behaves
 * as written rather than that the query does. These are the assertions that
 * would actually catch a regression.
 *
 * `maxWorkers: 1` because the suite shares one database: parallel workers would
 * interleave writes and make the round-robin load counts non-deterministic.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  maxWorkers: 1,
  testTimeout: 30000,
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  clearMocks: true,
};
