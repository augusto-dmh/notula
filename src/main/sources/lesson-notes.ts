// SPDX-License-Identifier: Apache-2.0
// Lesson notes when a lesson ends: for a finished lesson of a course whose `on_end` is `notes`,
// with no lesson notes yet and at least 150 words watched, generate once with the Lesson template
// from the watched part. Driven by bus `sources:lesson-finished`.
//
// Not written yet: nothing is generated.

import type { MainContext } from '../context'

export async function onLessonFinished(_ctx: MainContext, _noteId: string): Promise<void> {}
