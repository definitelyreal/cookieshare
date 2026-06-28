/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.ts"],
  moduleNameMapper: {
    "@raycast/api": "<rootDir>/src/utils/__tests__/__mocks__/@raycast/api.ts",
  },
};
