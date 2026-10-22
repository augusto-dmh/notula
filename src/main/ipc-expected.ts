// SPDX-License-Identifier: Apache-2.0
// Electron logs every rejected invoke to stderr with the error's full stack ("Error
// occurred in handler for '<channel>': …"). A coded rejection the renderer expects and
// shows, such as a local model server that is down, a key that is not set yet or
// storage still in recovery, is not a crash. `expected()` drops its stack, so the log
// keeps one line. The renderer still receives the same message.
// Programming errors and `internal` failures keep their stacks.

export function expected<E extends Error>(err: E): E {
  err.stack = `${err.name}: ${err.message}`
  return err
}
