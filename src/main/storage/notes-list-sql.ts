// SPDX-License-Identifier: Apache-2.0
// The notes-list query text (`listNotes`), kept free of imports so a dev check can run it
// on an in-memory database (scripts/dev/notes-list-check.ts).
//
// `listable` reads only the list columns plus what the dedupe needs, never the note bodies:
// every listable note passes through it before the dedupe and the LIMIT.

/**
 * `listable` is the WHERE fragment over `documents d`, `columns` the output columns
 * (NOTE_LIST_COLUMNS). Parameters: @owner, @workspace, @folderId, @ids, @ownOnly, @tags,
 * @exclude, @limit.
 */
export function notesListSql(listable: string, columns: readonly string[]): string {
  return `WITH listable AS (
         SELECT ${columns.map((c) => `d.${c}`).join(', ')}, d.is_event_main_note,
           CASE WHEN d.event_id IS NULL THEN NULL
                ELSE coalesce(json_extract(d.linked_event, '$.iCalUID'), d.event_id) END AS dedupe_event
         FROM documents d
         WHERE ${listable}
           AND (@folderId IS NULL OR EXISTS (
             SELECT 1 FROM folder_notes fn WHERE fn.folder_id = @folderId AND fn.note_id = d.id
           ))
           AND (@ids IS NULL OR d.id IN (SELECT value FROM json_each(@ids)))
           AND (@ownOnly = 0 OR (d.owner_id = @owner AND d.is_shared = 0))
           AND (@tags IS NULL OR NOT EXISTS (
             SELECT 1 FROM json_each(@tags) f
             WHERE NOT EXISTS (
               SELECT 1 FROM document_tags t
               WHERE t.document_id = d.id AND t.category = json_extract(f.value, '$.category')
                 AND EXISTS (
                   SELECT 1 FROM json_each(json_extract(f.value, '$.values')) v
                   WHERE (v.type = 'null' AND t.value IS NULL) OR (v.type = 'text' AND t.value = v.value)
                 )
             )
           ))
       ),
       ranked AS (
         SELECT *,
           CASE WHEN dedupe_event IS NULL THEN 1 ELSE row_number() OVER (
             PARTITION BY dedupe_event, sort_epoch
             ORDER BY is_event_main_note DESC, (owner_id = @owner) DESC, id ASC
           ) END AS dedupe_rank
         FROM listable
       )
       SELECT ${columns.join(', ')} FROM ranked r
       WHERE dedupe_rank = 1
         AND NOT EXISTS (
           SELECT 1 FROM json_each(@exclude) x
           WHERE r.event_id = json_extract(x.value, '$.eventId')
             AND r.sort_epoch = json_extract(x.value, '$.displayTimeUnixSeconds')
         )
       ORDER BY sort_epoch DESC, id ASC
       LIMIT @limit`
}
