// SPDX-License-Identifier: Apache-2.0
// The notula-storage utility process entry, built to out/main/storage.js and
// forked by main (index.ts). Serves the RPC in protocol.ts over the parent port:
// one request at a time, synchronously, so one call is one committed write batch.

import { StorageEngine } from './engine'
import type { WorkerEvent, WorkerRequest } from './protocol'

const port = process.parentPort

const engine = new StorageEngine((event: WorkerEvent) => port.postMessage(event))

port.on('message', (e) => {
  const req = e.data as WorkerRequest
  port.postMessage(engine.handle(req))
})

port.postMessage({ type: 'hello' } satisfies WorkerEvent)
