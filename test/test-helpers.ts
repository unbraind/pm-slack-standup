/**
 * Shared test helpers used across multiple test files in this package.
 *
 * Extracted to eliminate duplicated assert.throws matcher closures and test
 * fixture setup blocks that jscpd flagged as clone pairs. This module is not a
 * `*.test.ts` file, so the Node test runner never executes it directly; it is
 * imported by the test files that need its helpers.
 */

import { CommandError } from "../index.ts";

/**
 * Build an `assert.throws` validator that checks the thrown value is a
 * {@link CommandError} with the given `exitCode` and a message matching every
 * supplied `messagePattern`.
 *
 * Replaces the repeated `(e: any) => e.exitCode === N && /pat/.test(e.message)`
 * closures scattered across the suite. Uses `unknown` (not `any`) so the lint
 * policy's `no-restricted-syntax` `TSAnyKeyword` ban is respected, and narrows
 * with `instanceof` rather than a cast so a non-`CommandError` thrown value is
 * a clean validator failure instead of a property-access crash.
 *
 * @param exitCode - The numeric `exitCode` the thrown CommandError must carry.
 * @param messagePatterns - Zero or more regexes the error message must match.
 * @returns A validator function suitable as the second argument to
 *          `assert.throws`.
 */
export function expectCommandError(
  exitCode: number,
  ...messagePatterns: RegExp[]
): (e: unknown) => boolean {
  return (e: unknown): boolean =>
    e instanceof CommandError &&
    e.exitCode === exitCode &&
    messagePatterns.every((p) => p.test(e.message));
}