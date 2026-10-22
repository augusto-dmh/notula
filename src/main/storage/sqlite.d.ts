// SPDX-License-Identifier: Apache-2.0
// Types for the subset of better-sqlite3-multiple-ciphers 13.0.3 that the storage
// worker uses. The package ships index.d.ts, but its package.json "exports" map has
// no "types" condition, so `moduleResolution: Bundler` cannot reach it.

declare module 'better-sqlite3-multiple-ciphers' {
  namespace BetterSqlite3 {
    interface RunResult {
      changes: number
      lastInsertRowid: number | bigint
    }

    interface Statement {
      run(...params: unknown[]): RunResult
      get(...params: unknown[]): unknown
      all(...params: unknown[]): unknown[]
    }

    interface Transaction<F extends (...args: never[]) => unknown> {
      (...args: Parameters<F>): ReturnType<F>
      deferred(...args: Parameters<F>): ReturnType<F>
      immediate(...args: Parameters<F>): ReturnType<F>
      exclusive(...args: Parameters<F>): ReturnType<F>
    }

    interface Options {
      readonly?: boolean
      fileMustExist?: boolean
      timeout?: number
    }

    interface Database {
      readonly open: boolean
      readonly inTransaction: boolean
      prepare(source: string): Statement
      exec(source: string): this
      pragma(source: string, options?: { simple?: boolean }): unknown
      transaction<F extends (...args: never[]) => unknown>(fn: F): Transaction<F>
      close(): this
    }

    interface DatabaseConstructor {
      new (filename: string, options?: Options): Database
    }
  }

  const BetterSqlite3: BetterSqlite3.DatabaseConstructor
  export = BetterSqlite3
}
