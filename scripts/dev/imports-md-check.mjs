// SPDX-License-Identifier: Apache-2.0
// Dev-only harness for the Markdown importer. Runs the pure parts
// (front-matter, dates, rewrite, transcripts, links) and the scan → items → statuses pipeline on
// the synthetic fixtures in scripts/dev/fixtures/imports-md/. No Electron, no storage, nothing
// written anywhere.
//
// Run:  node scripts/dev/imports-md-check.mjs                    every check; exits 1 on a failure
//       node scripts/dev/imports-md-check.mjs <folder> [preset]  scans a folder read-only and prints
//                                                               the preview's counts as JSON
//
// The folder form prints counts only (formats, statuses, skip reasons, contents), never titles,
// paths or content, so it can run on a copy of a real vault (the import preview without the UI).
//
// The TypeScript sources load through Node's type stripping; the resolve hook maps `@shared/…`
// and extensionless relative imports to their `.ts` files.

import { registerHooks } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

registerHooks({
  resolve(specifier, context, next) {
    let r
    if (specifier.startsWith('@shared/')) r = next(pathToFileURL(resolve(root, 'src/shared', `${specifier.slice(8)}.ts`)).href, context)
    else if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) r = next(new URL(`${specifier}.ts`, context.parentURL).href, context)
    else r = next(specifier, context)
    return r.url.endsWith('.ts') ? { ...r, format: 'module-typescript' } : r
  }
})

const src = (p) => pathToFileURL(resolve(root, p)).href
const { splitFrontMatter, fmGet } = await import(src('src/main/imports-md/frontmatter.ts'))
const { parseDateText } = await import(src('src/main/imports-md/dates.ts'))
const { rewriteMarkdown, plainText, unshiftHeadings } = await import(src('src/main/imports-md/rewrite.ts'))
const { parseTranscript, looksLikeTranscript } = await import(src('src/main/imports-md/transcript.ts'))
const { classifyLink } = await import(src('src/main/imports-md/links.ts'))
const { scanFolder } = await import(src('src/main/imports-md/scan.ts'))
const { formItems, computeRows, summarize, parseSpec, specFiles, sourceKey } = await import(src('src/main/imports-md/plan.ts'))
const { notesText } = await import(src('src/main/imports-md/formats.ts'))

const FIX = resolve(root, 'scripts/dev/fixtures/imports-md')
const OPTIONS = { folderMode: 'mirror', trash: 'skip', findSourcesAfter: true, includeOtherFiles: false }
const PANEL_TITLES = new Set(['summary', 'team meeting', 'one-on-one'])
const ENV = { dayFirst: false, panelTitles: PANEL_TITLES }
const NO_MATCHES = { items: [], exportNotes: [] }

let failures = 0
let checks = 0
function check(name, cond, detail) {
  checks++
  if (!cond) {
    failures++
    console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
}

function statusEnv(rootDir, matches = NO_MATCHES, folders = []) {
  return { root: rootDir, matches, lookup: { folders }, titleDates: new Set(), labels: { single: 'Fixture', videos: ['Videos'] }, platform: 'win32' }
}

async function preview(dir, preset = 'auto', options = OPTIONS, matches = NO_MATCHES, folders = []) {
  const scan = await scanFolder(dir)
  const formed = formItems(scan, preset, ENV)
  const env = statusEnv(dir, matches, folders)
  const rows = computeRows(formed, options, env)
  return { scan, formed, rows, env, summary: summarize(rows, env.lookup) }
}

/** The item's full parse, as the run would build it (reads the fixture files again). */
async function fullParse(scan, formed, relPath) {
  const it = formed.items.find((i) => i.relPath === relPath)
  if (!it?.spec) return null
  const files = {}
  for (const rel of specFiles(it.spec)) files[rel] = scan.files.find((f) => f.rel === rel) ?? null
  return parseSpec(it.spec, files, { dayFirst: false, panelTitles: PANEL_TITLES, exportSummaries: null })
}

function folderMode(dir) {
  return async () => {
    const preset = process.argv[3] ?? 'auto'
    const { formed, rows, summary } = await preview(resolve(dir), preset)
    const count = (f) => rows.reduce((m, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m), {})
    console.log(
      JSON.stringify(
        {
          studyVault: formed.studyVault,
          catalogs: formed.catalogs.length,
          summary,
          formats: count((r) => r.format),
          statuses: count((r) => r.status),
          skipReasons: count((r) => (r.status === 'skipped' || r.status === 'unreadable' ? r.detail : '—')),
          titleOrigins: count((r) => r.titleOrigin),
          dateOrigins: count((r) => r.dateOrigin),
          transcripts: {
            timed: rows.filter((r) => r.contents.transcript?.timed).length,
            untimed: rows.filter((r) => r.contents.transcript && !r.contents.transcript.timed).length,
            lines: rows.reduce((n, r) => n + (r.contents.transcript?.lines ?? 0), 0)
          },
          withSummary: rows.filter((r) => r.contents.summaries > 0).length,
          sources: rows.reduce((n, r) => n + r.contents.sources, 0),
          references: rows.reduce((n, r) => n + r.contents.references, 0),
          folders: new Set(rows.filter((r) => r.folderPath.length).map((r) => r.folderPath.join('/'))).size,
          warnings: count((r) => (r.warnings.length ? r.warnings.map((w) => w.replace(/ .*$/, '…')).join('|') : '—'))
        },
        null,
        2
      )
    )
  }
}

if (process.argv[2]) {
  await folderMode(process.argv[2])()
  process.exit(0)
}

// ---------- front-matter ----------
{
  const t = `---\ntitle: "A \\"quoted\\" title"\ndate: 2026-02-10\ntags: [a, "b c"]\nlist:\n  - x\n  - 'y'\nmap:\n  k: v\npeople:\n  - name: "Ana"\n    email: null\nblock: |\n  text\nnested:\n  deeper:\n    still:\n      too: far\nsource:\n  url: "https://youtu.be/AbCdEfGhIjK"\n  series:\n    title: "S"\n---\nBody`
  const { fm, body } = splitFrontMatter(t)
  check('fm: title JSON-quoted', fmGet(fm, 'title') === 'A "quoted" title', fmGet(fm, 'title'))
  check('fm: plain date', fmGet(fm, 'date') === '2026-02-10')
  check('fm: flow list', JSON.stringify(fmGet(fm, 'tags')) === '["a","b c"]', fmGet(fm, 'tags'))
  check('fm: block list', JSON.stringify(fmGet(fm, 'list')) === '["x","y"]', fmGet(fm, 'list'))
  check('fm: nested map', JSON.stringify(fmGet(fm, 'map')) === '{"k":"v"}')
  check('fm: two-level map (format 2 source)', JSON.stringify(fmGet(fm, 'source')) === '{"url":"https://youtu.be/AbCdEfGhIjK","series":{"title":"S"}}', fmGet(fm, 'source'))
  check('fm: list of maps', JSON.stringify(fmGet(fm, 'people')) === '[{"name":"Ana","email":null}]', fmGet(fm, 'people'))
  check('fm: unread keys', fm.unread.includes('block') && fm.unread.includes('nested'), fm.unread)
  check('fm: body', body === 'Body')
  check('fm: none', splitFrontMatter('# x').fm === null)
}

// ---------- dates ----------
{
  const ref = new Date(2026, 9, 1).getTime()
  const d = (s) => parseDateText(s, { refMs: ref, dayFirst: false })
  const ymd = (x) => (x ? `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()} ${x.getHours()}` : null)
  check('date: en-GB short', ymd(d('Sun, 26 Jul 26')) === '2026-7-26 12', ymd(d('Sun, 26 Jul 26')))
  check('date: ISO date at noon', ymd(d('2026-08-15')) === '2026-8-15 12')
  check('date: 26 Jul 2026', ymd(d('26 Jul 2026')) === '2026-7-26 12')
  check('date: Jul 26, 2026', ymd(d('Jul 26, 2026')) === '2026-7-26 12')
  check('date: yearless before ref', ymd(d('Aug 8')) === '2026-8-8 12')
  check('date: yearless after ref goes back a year', ymd(d('Dec 20')) === '2025-12-20 12', ymd(d('Dec 20')))
  check('date: Portuguese', ymd(d('26 de julho de 2026')) === '2026-7-26 12')
  check('date: dd/mm when day > 12', ymd(d('26/07/2026')) === '2026-7-26 12')
  check('date: ambiguous dd/mm refused', d('05/07/2026') === null)
  check('date: unknown', d('unknown (no note)') === null)
  check('date: ISO with zone', d('2026-09-01T09:00:00.000Z')?.toISOString() === '2026-09-01T09:00:00.000Z')
}

// ---------- rewrite ----------
{
  const r = rewriteMarkdown('# A\n## B\n### C\n> q\n|a|b|\n|-|-|\n|1|2|\n[x](file:///c) [y](https://e.test)\n![i](img.png)\n<b>bold</b><!-- c -->\n```\n### kept\n```', { obsidian: false })
  const md = r.markdown
  check('rewrite: h1 kept', md.includes('# A'))
  check('rewrite: h3 → bold', md.includes('**C**') && !md.includes('### C'), md)
  check('rewrite: quote marker dropped', md.includes('\nq\n') || md.includes('\nq'), md)
  check('rewrite: table rows', md.includes('a · b') && md.includes('1 · 2') && !md.includes('|-|'), md)
  check('rewrite: file link → text', md.includes('x [y](https://e.test)'), md)
  check('rewrite: local image placeholder', md.includes('[image: i]') && r.attachments.includes('img.png'))
  check('rewrite: html stripped', md.includes('bold') && !md.includes('<b>') && !md.includes('<!--'))
  check('rewrite: code fence untouched', md.includes('```\n### kept\n```'), md)
  check('rewrite: panel keeps h3', rewriteMarkdown('### C', { obsidian: false, panel: true }).markdown === '### C')
  check('plain text', plainText('## Head\n- **bold** [l](https://x.test)') === 'Head\nbold l', plainText('## Head\n- **bold** [l](https://x.test)'))
  check('unshift', unshiftHeadings('## a\n### b\n```\n## c\n```') === '# a\n## b\n```\n## c\n```')
}

// ---------- transcripts ----------
{
  const timed = parseTranscript('Meeting Title: X\nDate: Jul 28\n\nTranscript (YouTube captions, pt-orig, fetched):\n[00:02] one\ntwo\n[01:00:05] three')
  check('transcript: timed', timed.kind === 'timed' && timed.turns.length === 2 && timed.turns[0].text === 'one two', timed)
  check('transcript: language', timed.language === 'pt')
  check('transcript: last anchor', timed.lastAnchorMs === 3_605_000 && timed.turns[1].endMs === 3_635_000)
  check('transcript: first end = next start', timed.turns[0].endMs === 3_605_000)
  const untimed = parseTranscript('Transcript:\nMe: hi\nThem: hello\nGrace Hopper: yes\ncontinued')
  check('transcript: untimed', untimed.kind === 'untimed' && untimed.turns.length === 3, untimed.turns)
  check('transcript: speakers', untimed.turns[0].source === 'microphone' && untimed.turns[1].source === 'system' && untimed.turns[2].speaker === 'Grace Hopper')
  check('transcript: continuation', untimed.turns[2].text === 'yes continued')
  check('transcript: 1 s apart', untimed.turns[2].startMs === 2000 && untimed.turns[2].endMs === 3000)
  check('transcript: placeholder', parseTranscript('Transcript:\nVerbatim transcript is not available from the source.').kind === 'placeholder')
  check('transcript: short body is placeholder', parseTranscript('Transcript:\nok').kind === 'placeholder')
  check('transcript: header grammar', looksLikeTranscript('Meeting Title: a\nDate: b\n\nTranscript:\nMe: x') && !looksLikeTranscript('# Note\nTranscript:'))
}

// ---------- links ----------
{
  const yt = classifyLink('https://www.youtube.com/watch?v=AbCdEfGhIjK&t=42s', 'Video', true)
  check('link: labelled video is a source', yt?.role === 'source' && yt.canonicalKey === 'youtube:AbCdEfGhIjK' && yt.startMs === 42_000, yt)
  check('link: unlabelled video is a reference', classifyLink('https://youtu.be/AbCdEfGhIjK', null, false)?.role === 'reference')
  check('link: course root is a series', classifyLink('https://academy.test/c/widgets/', 'Class', true)?.role === 'series')
  const lesson = classifyLink('https://academy.test/c/widgets/sections/1/lessons/2', 'Lesson', true)
  check('link: lesson URL is a source', lesson?.role === 'source' && lesson.canonicalKey === 'circle:academy.test:2', lesson)
  check('link: playlist is a series', classifyLink('https://www.youtube.com/playlist?list=PLabc123', null, false)?.canonicalKey === 'youtube:playlist:PLabc123')
  check('link: a notes-app share link is plain', classifyLink('https://notes.sampleapp.test/d/x', 'Video', true)?.role === 'plain')
  check('link: non-http ignored', classifyLink('file:///c/x', null, false) === null)
}

// ---------- study vault ----------
{
  const dir = resolve(FIX, 'study-vault')
  const { scan, formed, rows, summary } = await preview(dir)
  const row = (p) => rows.find((r) => r.relPath === p)
  check('study: detected', formed.studyVault)
  check('study: five lessons', rows.filter((r) => r.format === 'study-lesson').length === 5, rows.filter((r) => r.format === 'study-lesson').map((r) => r.relPath))
  check('study: catalog per course', formed.catalogs.length === 1 && formed.catalogs[0].course === 'Widget Basics (Complete Course)', formed.catalogs.map((c) => c.course))
  const skippedAs = (p, reason) => check(`study: ${p} skipped`, row(p)?.status === 'skipped' && row(p)?.detail === reason, row(p))
  skippedAs('Dashboard.md', 'Not part of the study notes')
  skippedAs('README.md', 'Not part of the study notes')
  skippedAs('docs/layout.md', 'Not part of the study notes')
  skippedAs('courses/widget-basics/README.md', 'Course overview, not a lesson')
  skippedAs('courses/widget-basics/CURRICULUM.md', 'Course outline: import it as a catalog after Find sources')
  skippedAs('courses/widget-basics/sessions/2026-08-02.md', 'Study sessions aren’t lessons')
  skippedAs('courses/widget-basics/2-first-widget/scratch.md', 'Not part of a lesson')

  const welcome = row('courses/widget-basics/1-welcome')
  check('study: placeholder has no transcript', welcome?.contents.transcript === null)
  check('study: No Content gives no panel', welcome?.contents.summaries === 0)
  check('study: an app title prefix is stripped', welcome?.title === '[Curso] Widget Basics - Aula 1 - Welcome', welcome?.title)
  check('study: lesson folder', JSON.stringify(welcome?.folderPath) === '["Widget Basics (Complete Course)"]', welcome?.folderPath)
  check('study: unknown date → file time', welcome?.dateOrigin === 'file-time')
  const wp = await fullParse(scan, formed, 'courses/widget-basics/1-welcome')
  check('study: class root → series, lesson → source', wp.candidates.some((c) => c.role === 'series') && wp.candidates.some((c) => c.role === 'source' && c.canonicalKey === 'circle:example-academy.test:2001'), wp.candidates)
  check('study: hints', wp.hints.lessonFromTitle === 1 && wp.hints.lessonFromFolder === 1 && wp.hints.series === 'Widget Basics (Complete Course)', wp.hints)
  check('study: body is the hyperlinks', wp.notesMd.includes('Lesson - https://www.example-academy.test/c/widget-basics/sections/1001/lessons/2001'), wp.notesMd)

  const first = row('courses/widget-basics/2-first-widget')
  check('study: untimed transcript', first?.contents.transcript?.lines === 4 && first.contents.transcript.timed === false, first?.contents)
  check('study: summary panel', first?.contents.summaries === 1)
  check('study: Date: line', first?.dateOrigin === 'date-line' && new Date(first.createdAt).getDate() === 26)
  const fp = await fullParse(scan, formed, 'courses/widget-basics/2-first-widget')
  check('study: summary keeps h3, deeper → bold, date line dropped', fp.panels[0].markdown.startsWith('### Building the frame') && fp.panels[0].markdown.includes('**Gear sizes**') && !fp.panels[0].markdown.includes('Sun, 26'), fp.panels[0].markdown)
  check('study: empty hyperlinks → empty body', fp.notesMd === '')

  const bonus = row('courses/widget-basics/bonus-tour')
  check('study: unnumbered lesson title from summary', bonus?.title === 'Tour of the workshop' && bonus.titleOrigin === 'summary-heading', bonus)
  check('study: yearless summary date', bonus?.dateOrigin === 'summary-date')

  const gears = row('courses/videos/1-gears-explained')
  check('study: timed transcript', gears?.contents.transcript?.timed === true && gears.contents.transcript.lines === 3, gears?.contents)
  check('study: videos folder', JSON.stringify(gears?.folderPath) === '["Videos"]')
  const gp = await fullParse(scan, formed, 'courses/videos/1-gears-explained')
  check('study: language from origin', gp.transcript.language === 'en')
  check('study: video source with t=', gp.candidates.some((c) => c.role === 'source' && c.canonicalKey === 'youtube:AbCdEfGhIjK' && c.startMs === 42_000), gp.candidates)
  check('study: share link plain, references', gp.candidates.filter((c) => c.role === 'plain').length === 1 && gp.candidates.filter((c) => c.role === 'reference').length === 2, gp.candidates)
  check('study: videos ignore folder number', gp.hints.lessonFromFolder === null && gp.hints.series === null)
  check('study: last anchor', gp.transcript.lastAnchorMs === 3_725_000)

  const clip = await fullParse(scan, formed, 'courses/videos/2-short-clip')
  check('study: placeholder Video line → source', clip.transcript === null && clip.candidates.some((c) => c.role === 'source' && c.canonicalKey === 'youtube:ZyXwVuTsRqP'), clip.candidates)

  check('study: summary line', summary.notes === 5 && summary.summaries === 3 && summary.transcripts === 2 && summary.newFolders === 2, summary)

  const other = computeRows(formed, { ...OPTIONS, includeOtherFiles: true }, statusEnv(dir))
  check('study: other files when asked', other.find((r) => r.relPath === 'Dashboard.md')?.status === 'new' && other.find((r) => r.relPath === 'docs/layout.md')?.status === 'new')

  // Re-import: same key and hash → already imported; a different hash → changed; Trash; purged.
  const lesson = formed.items.find((i) => i.relPath === 'courses/widget-basics/2-first-widget')
  const key = sourceKey(dir, lesson.relPath, 'win32')
  const m = (hash, note_state) => ({ items: [{ id: 'x', batch_id: 'b', source_key: key, rel_path: lesson.relPath, content_hash: hash, state: 'done', note_id: 'n', note_state }], exportNotes: [] })
  const st = (matches) => computeRows(formed, OPTIONS, statusEnv(dir, matches)).find((r) => r.itemId === lesson.id)
  check('dedupe 1: already imported', st(m(lesson.hash, 'live')).status === 'already-imported' && !st(m(lesson.hash, 'live')).tickable)
  check('dedupe 2: in Trash', st(m(lesson.hash, 'trashed')).status === 'in-trash' && !st(m(lesson.hash, 'trashed')).ticked)
  check('dedupe 3: purged', st(m(lesson.hash, 'purged')).status === 'new' && !st(m(lesson.hash, 'purged')).ticked)
  check('dedupe 4: changed', st(m('0'.repeat(64), 'live')).status === 'changed' && !st(m('0'.repeat(64), 'live')).ticked)
  const reused = computeRows(formed, OPTIONS, statusEnv(dir, NO_MATCHES, [{ id: 'f1', title: 'videos', parent_id: null }])).find((r) => r.relPath === 'courses/videos/1-gears-explained')
  check('folders: reuse by title', reused.folderExists && reused.warnings.some((w) => w.startsWith('Adds to your existing folder')), reused)
}

// ---------- Obsidian ----------
{
  const dir = resolve(FIX, 'obsidian')
  const { scan, formed, rows } = await preview(dir)
  check('obsidian: hidden and node_modules not listed', !rows.some((r) => r.relPath.includes('.obsidian') || r.relPath.includes('node_modules')), rows.map((r) => r.relPath))
  check('obsidian: format from .obsidian/', rows.filter((r) => r.status === 'new').every((r) => r.format === 'obsidian'))
  const daily = rows.find((r) => r.relPath === 'Daily/2026-03-04.md')
  check('obsidian: date from file name', daily?.dateOrigin === 'file-name' && JSON.stringify(daily.folderPath) === '["Daily"]', daily)
  const dr = rows.find((r) => r.relPath === 'Projects/Alpha/Deep/Design review.md')
  check('obsidian: front-matter title and date', dr?.title === 'Design review: alpha' && dr.titleOrigin === 'front-matter' && dr.dateOrigin === 'front-matter', dr)
  check('obsidian: flattened', JSON.stringify(dr?.folderPath) === '["Projects","Alpha"]' && dr.warnings.some((w) => w.startsWith('Flattened from')), dr)
  check('obsidian: warnings', dr.warnings.includes('Some properties weren’t read') && dr.warnings.some((w) => w.startsWith('Not imported: rating')) && dr.warnings.includes('Attachments aren’t imported yet'), dr.warnings)
  const p = await fullParse(scan, formed, 'Projects/Alpha/Deep/Design review.md')
  const md = p.notesMd
  check('obsidian: callout', md.includes('**Mind the gap**') && md.includes('The gap between gears'), md)
  check('obsidian: table rows', md.includes('Gear · 12 mm'))
  check('obsidian: wikilink alias', md.includes('small gears') && !md.includes('[['))
  check('obsidian: embeds', md.includes('[embedded: diagram.png]') && md.includes('[embedded note: Other note]'))
  check('obsidian: highlight, comment, block id', md.includes('highlighted text') && !md.includes('%%') && !md.includes('^abc123'), md)
  check('obsidian: inline tag stays, front-matter-only tags line', md.includes('Inline #review tag') && md.endsWith('Tags: #design'), md)
  check('obsidian: first H1 kept when title is in properties', md.includes('# Ignored heading'))
  check('obsidian: attendees', p.attendees.length === 2 && p.attendees[0].email === 'ana@example.test')
  check('obsidian: front-matter source', p.candidates.some((c) => c.role === 'source' && c.canonicalKey === 'youtube:QwErTyUiOp1'), p.candidates)
  check('obsidian: series hint', p.hints.series === 'Widget Basics')
  const daily2 = await fullParse(scan, formed, 'Daily/2026-03-04.md')
  check('obsidian: wikilink text and targets', daily2.notesMd.includes('the road map') && daily2.meta.wikilinks.includes('Roadmap'))
}

// ---------- plain ----------
{
  const dir = resolve(FIX, 'plain')
  const { scan, formed, rows } = await preview(dir)
  const ks = await fullParse(scan, formed, 'kitchen-sink.md')
  const md = ks.notesMd
  check('plain: H1 → title', ks.title === 'Kitchen sink' && ks.titleOrigin === 'heading' && !md.startsWith('# Kitchen'))
  check('plain: H3/H6 → bold', md.includes('**Level three**') && md.includes('**Level six**'))
  check('plain: code kept', md.includes('const x = 1'))
  check('plain: quote', md.includes('A quoted line') && !md.includes('> A quoted'))
  check('plain: links', md.includes('local file and relative and [web](https://example.test/page)'), md)
  check('plain: images', md.includes('[remote](https://img.example.test/a.png)') && md.includes('[image: local]'))
  check('plain: html', md.includes('Some html') && !md.includes('<div>') && !md.includes('hidden comment'))
  check('plain: footnotes moved', /\*\*Notes\*\*\n\n\\\[\^1\\\]: The footnote text\.$/.test(md), md)
  check('plain: search text', notesText(ks).includes('Level three') && !notesText(ks).includes('**'))
  const standup = rows.find((r) => r.relPath === 'sub/standup.md')
  check('plain: paired transcript', standup?.contents.transcript?.lines === 2 && !rows.some((r) => r.relPath === 'sub/standup - Transcript.txt'), rows.map((r) => r.relPath))
  check('plain: Date: line', standup?.dateOrigin === 'date-line')
  const sp = await fullParse(scan, formed, 'sub/standup.md')
  check('plain: named speaker', sp.transcript.turns[1].speaker === 'Ada Lovelace')
  const dup = rows.filter((r) => r.relPath === 'again.md' || r.relPath === 'sub/copy-of-standup.md')
  check('plain: duplicate in this preview', dup.filter((r) => r.status === 'duplicate').length === 1 && dup.filter((r) => r.status === 'new').length === 1, dup.map((r) => [r.relPath, r.status]))
  check('plain: binary skipped', rows.find((r) => r.relPath === 'sub/blob.md')?.detail === 'Not a text file')
  check('plain: attachment skipped', rows.find((r) => r.relPath === 'sub/photo.png')?.detail === 'Attachments aren’t imported yet')
  const lone = rows.find((r) => r.relPath === 'lone-transcript.md')
  check('plain: lone transcript', lone?.format === 'transcript-copy' && lone.title === 'Supplier call' && lone.contents.transcript?.lines === 2, lone)
  const single = computeRows(formed, { ...OPTIONS, folderMode: 'single' }, statusEnv(dir)).find((r) => r.relPath === 'sub/standup.md')
  check('folders: one new folder', JSON.stringify(single.folderPath) === '["Fixture","sub"]', single.folderPath)
  const none = computeRows(formed, { ...OPTIONS, folderMode: 'none' }, statusEnv(dir)).find((r) => r.relPath === 'sub/standup.md')
  check('folders: none', none.folderPath.length === 0)
}

// ---------- Notula export ----------
{
  const dir = resolve(FIX, 'export')
  const { scan, formed, rows } = await preview(dir)
  const ex = rows.filter((r) => r.format === 'notula-export')
  check('export: notes found', ex.length === 3, rows.map((r) => [r.relPath, r.format, r.status]))
  const base = 'Notula export 2026-10-01 12.00/notes/'
  const weekly = await fullParse(scan, formed, `${base}2026-09-01 Weekly sync (11111111).md`)
  const ctxIdx = formed.items.find((i) => i.relPath === `${base}2026-09-01 Weekly sync (11111111).md`)
  check('export: id kept', weekly.exportId === '11111111-2222-4333-8444-555555555555')
  check('export: created_at as is', weekly.createdAt.toISOString() === '2026-09-01T09:00:00.000Z')
  check('export: body = My notes with headings back up', weekly.notesMd.startsWith('# Decisions') && weekly.notesMd.includes('## Detail') && !weekly.notesMd.includes('Weekly sync'), weekly.notesMd)
  check('export: summary panel', weekly.panels.length === 1 && weekly.panels[0].title === 'Summary' && weekly.panels[0].markdown.startsWith('## Highlights'), weekly.panels)
  check('export: transcript paired, untimed', weekly.transcript?.kind === 'untimed' && weekly.transcript.turns.length === 2 && weekly.transcript.turns[0].source === 'microphone')
  check('export: attendees', weekly.attendees.length === 2 && weekly.attendees[1].email === 'bo@example.test', weekly.attendees)
  check('export: known tag categories only', weekly.tags.length === 1 && weekly.tags[0].category === 'meeting_kind')
  check('export: calendar not restored', weekly.warnings.includes('Calendar link not restored'))
  const wrow = rows.find((r) => r.itemId === ctxIdx.id)
  check('export: folders by name', JSON.stringify(wrow.folderPath) === '["Team"]', wrow.folderPath)
  check('export: transcript file claimed', !rows.some((r) => r.relPath.endsWith('.txt') && r.relPath.includes('transcripts/')))
  // The index's has_summary decides the split; run it with the index the way the run does.
  const heading = rows.find((r) => r.relPath.includes('Team meeting heading'))
  check('export: template-like heading stays in the body', heading.contents.summaries === 0 && heading.warnings.includes('Summary may be inside the note text'), heading)
  const trash = rows.find((r) => r.relPath.includes('Old draft'))
  check('export: Trash skipped by default', trash.status === 'skipped' && trash.detail === 'In Trash in the export')
  const intoTrash = computeRows(formed, { ...OPTIONS, trash: 'import-into-trash' }, statusEnv(dir)).find((r) => r.relPath.includes('Old draft'))
  check('export: Trash imported when asked', intoTrash.status === 'new')
  const here = computeRows(formed, OPTIONS, statusEnv(dir, { items: [], exportNotes: [{ id: '11111111-2222-4333-8444-555555555555', state: 'live' }] })).find((r) => r.itemId === ctxIdx.id)
  check('export: already in Notula', here.status === 'already-in-notula' && !here.tickable)
  check('export: index and database skipped', rows.filter((r) => /index\.csv|README\.txt|notula\.db/.test(r.relPath)).every((r) => r.status === 'skipped'))
}

// ---------- export format 2 ----------
{
  const dir = resolve(FIX, 'export2')
  const { scan, formed, rows } = await preview(dir)
  const std = 'Notula export 2026-10-02 12.00/notes/2026-10-02 Event sourcing (aaaaaaaa).md'
  const md = 'Notula Markdown export 2026-10-02 12.00/Courses/Fundamentos/2 - Modules.md'
  const es = await fullParse(scan, formed, std)
  check('v2: no newer-Notula warning', es.warnings.length === 0, es.warnings)
  check('v2: split by notula_sections', es.notesMd === '# Summary\nMy own heading named like a template.' && es.panels.length === 1 && es.panels[0].title === 'Summary · Oct 2' && es.panels[0].markdown === '## Highlights\n- Events are facts.', [es.notesMd, es.panels])
  check('v2: source block → exact source candidate', es.candidates.length === 1 && es.candidates[0].role === 'source' && es.candidates[0].canonicalKey === 'circle:academy.test:7', es.candidates)
  check('v2: series and lesson hints', es.hints.series === 'Fundamentos' && es.hints.lessonFromTitle === 7, es.hints)
  check('v2: Label after the anchor is the speaker', es.transcript?.turns[0].source === 'microphone' && es.transcript.turns[0].text === 'Bem-vindos ao curso.' && es.transcript.turns[1].speaker === 'Ada Lovelace' && es.transcript.turns[1].startMs === 65_000, es.transcript?.turns)
  const mod = await fullParse(scan, formed, md)
  check('v2 Markdown: flat source properties', mod.candidates[0]?.canonicalKey === 'circle:academy.test:2' && mod.hints.series === 'Fundamentos' && mod.hints.lessonFromTitle === 2, [mod.candidates, mod.hints])
  check('v2 Markdown: sub-folder transcript pairs with its note', mod.transcript?.turns.length === 2 && formed.items.find((i) => i.relPath === md)?.spec.files.transcript === md.replace(/\.md$/, '.transcript.md'))
  check('v2 Markdown: no transcript item of its own', !rows.some((r) => r.relPath.endsWith('.transcript.md')), rows.map((r) => [r.relPath, r.format, r.status]))
  const ports = formed.items.find((i) => i.relPath === 'copied/4 - Ports.md')
  check('v2 Markdown copied elsewhere: transcript beside the note', ports?.spec.files.transcript === 'copied/4 - Ports.transcript.md', ports?.spec)
  check('v2: every item new, nothing skipped', rows.length === 3 && rows.every((r) => r.status === 'new'), rows.map((r) => [r.relPath, r.status]))
  // A Markdown export transcript whose note doesn't name it is still part of the export.
  const orphan = formItems(
    { root: 'C:/mem/Notula Markdown export 2026-10-02 12.00', files: [
      { rel: 'A/1 - X.md', abs: '', name: '1 - X.md', text: '---\nid: "e"\nnotula_export_version: 2\n---\n', lossy: false, size: 1, mtimeMs: 1, birthtimeMs: 0, sha256: '1'.repeat(64) },
      { rel: 'A/1 - X.transcript.md', abs: '', name: '1 - X.transcript.md', text: 'Transcript:\n[00:01] Them: hello there, everyone', lossy: false, size: 1, mtimeMs: 1, birthtimeMs: 0, sha256: '2'.repeat(64) }
    ], skipped: [], dirs: new Set(['A']), obsidian: false, bytesRead: 0 },
    'auto',
    ENV
  )
  check('v2 Markdown: unnamed transcript skipped as export part', orphan.items.find((i) => i.relPath === 'A/1 - X.transcript.md')?.skip?.reason === 'Part of a Notula export', orphan.items.map((i) => [i.relPath, i.skip]))
  // Version 1 files still split by the title heuristic (the fixtures above), and a newer one warns.
  check('v3 warns', (await (async () => {
    const t = '---\nid: "f"\nnotula_export_version: 3\n---\n'
    const f = { rel: 'n.md', abs: '', name: 'n.md', text: t, lossy: false, size: t.length, mtimeMs: 1, birthtimeMs: 0, sha256: '3'.repeat(64) }
    const fm = formItems({ root: 'C:/mem', files: [f], skipped: [], dirs: new Set(), obsidian: false, bytesRead: 0 }, 'auto', ENV)
    return fm.items[0]?.info?.warnings ?? []
  })()).includes('Made by a newer Notula; some details may be missing'))
}

// ---------- pathological inputs ----------
// In memory: a scan result built by hand, so nothing touches the disk.
{
  const MB4 = 4 * 1024 * 1024 - 64
  const memFile = (rel, text) => ({ rel, abs: rel, name: rel.slice(rel.lastIndexOf('/') + 1), text, lossy: false, size: text.length, mtimeMs: 1_780_000_000_000, birthtimeMs: 0, sha256: String(text.length).padStart(64, '0') })
  const memScan = (files) => ({ root: 'C:/mem', files, skipped: [], dirs: new Set(), obsidian: false, bytesRead: 0 })
  /** The preview of one file plus its full parse (what the run does), timed. */
  const timed = (name, text, ms = 2_000) => {
    const t0 = performance.now()
    const scan = memScan([memFile('odd.md', text)])
    const formed = formItems(scan, 'auto', ENV)
    const it = formed.items[0]
    let parsed = null
    if (it?.spec) parsed = parseSpec(it.spec, { 'odd.md': scan.files[0] }, { dayFirst: false, panelTitles: PANEL_TITLES, exportSummaries: null })
    if (parsed) notesText(parsed)
    const took = performance.now() - t0
    check(`pathological: ${name} under ${ms} ms`, took < ms, `${Math.round(took)} ms`)
    return { formed, parsed }
  }
  const fill = (unit) => unit.repeat(Math.floor(MB4 / unit.length))
  timed('4 MB of [', fill('['))
  timed('4 MB of [[', fill('[['))
  timed('4 MB of ![', fill('!['))
  timed('4 MB of ![[', fill('![['))
  timed('4 MB of [a](', fill('[a]('))
  timed('4 MB of [a](b "', fill('[a](b "'))
  timed('4 MB of <!--', fill('<!--'))
  timed('4 MB of %% (Obsidian)', `---\ntags: [x]\n---\n${fill('%%a')}`)
  timed('heading of spaces', `# a${' '.repeat(MB4 - 8)}b`)
  timed('summary-style heading of spaces', `x\n## a${' '.repeat(MB4 - 8)}b`)
  timed('table row then spaces', `a | b\n${' '.repeat(MB4 - 16)}x`)
  timed('URL with trailing punctuation', `https://e.test/${'.'.repeat(MB4 - 32)}a`)
  timed('URL with a long dotted path', `see https://e.test/${'.,'.repeat(Math.floor(MB4 / 4))}`)
  // ~246k lines: linear (measured alone: 0.5 MB 125 ms, 4 MB ~0.9 s, 8 MB 1.8 s), but after the 4 MB
  // cases above the heap is full and it lands at 2.2-3.7 s under load; the quadratic bug took 200+ s.
  timed('many short lines of [', fill('[[[[[[[[[[[[[[[[\n'), 5_000)
  timed('quote markers then a separator', `${'> '.repeat(Math.floor(MB4 / 4))}\u2028x`)
  timed('front-matter key of spaces', `---\na${' '.repeat(60_000)}b\n---\nbody`)
  timed('attendee of spaces', `---\nattendees: "a${' '.repeat(60_000)}b"\n---\nbody`)
  timed('attendee with a long dotted domain', `---\nattendees: "a@${'.b'.repeat(30_000)}@"\n---\nbody`)

  // Deep flow nesting reads as unread, and one such file never fails the scan.
  const deep = `---\ntitle: Deep\nk: ${'['.repeat(5_000)}x${']'.repeat(5_000)}\n---\nbody`
  let threw = null
  let fm = null
  try {
    fm = splitFrontMatter(deep).fm
  } catch (e) {
    threw = e
  }
  check('nesting: 5,000 levels do not throw', threw === null, String(threw))
  check('nesting: deep key unread, others read', fm?.unread.includes('k') && fmGet(fm, 'title') === 'Deep', fm?.unread)
  check('nesting: depth 4 still reads', JSON.stringify(splitFrontMatter('---\nk: [a, b]\n---\n').fm?.data.k) === '["a","b"]')
  const mixed = formItems(memScan([memFile('deep.md', deep), memFile('fine.md', '# Fine\n\ntext')]), 'auto', ENV)
  check('nesting: the scan goes on', mixed.items.length === 2 && mixed.items.some((i) => i.relPath === 'fine.md' && i.info?.title === 'Fine'), mixed.items.map((i) => [i.relPath, i.skip]))
  const deepExport = `---\nnotula_export_version: 1\nid: "x"\nk: ${'{a: '.repeat(5_000)}1${'}'.repeat(5_000)}\n---\n`
  const mixed2 = formItems(memScan([memFile('e.md', deepExport), memFile('fine.md', 'text')]), 'auto', ENV)
  check('nesting: deep map in an export file', mixed2.items.length === 2, mixed2.items.map((i) => [i.relPath, i.skip]))

  // `__proto__` never replaces the prototype.
  const proto = splitFrontMatter('---\n__proto__:\n  title: Hijack\ntitle: Real\nmap:\n  __proto__: x\n  k: v\n---\n').fm
  check('proto: key not assigned', fmGet(proto, 'title') === 'Real' && Object.getPrototypeOf(proto.data) === Object.prototype && proto.unread.includes('__proto__'), proto)
  check('proto: nested key dropped', JSON.stringify(proto.data.map) === '{"k":"v"}' && Object.getPrototypeOf(proto.data.map) === Object.prototype, proto.data.map)

  // Behaviour kept on ordinary input.
  check('linear: wikilink with alias', rewriteMarkdown('see [[Page|the page]] and [[Other]]', { obsidian: true }).markdown === 'see the page and Other')
  check('linear: relative link with title', rewriteMarkdown('a [t](rel.md "Title") b', { obsidian: false }).markdown === 'a t b')
  check('linear: closing hashes', rewriteMarkdown('## Head ##', { obsidian: false }).markdown === '## Head')
  check('linear: comment pairs', rewriteMarkdown('a <!-- x --> b <!-- y', { obsidian: false }).markdown.startsWith('a  b'))
  check('linear: long line kept as written', rewriteMarkdown(`[[x]]${'a'.repeat(10_001)}`, { obsidian: true }).markdown.startsWith('[[x]]'))
  check('linear: person forms', JSON.stringify(timed('attendees', '---\nattendees: ["Ana <ana@e.test>", "bo@e.test", "Cy"]\n---\nx').parsed.attendees) === '[{"name":"Ana","email":"ana@e.test"},{"email":"bo@e.test"},{"name":"Cy"}]')
}

console.log(`${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
