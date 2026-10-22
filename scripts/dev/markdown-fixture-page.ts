// SPDX-License-Identifier: Apache-2.0
// The page half of `markdown-fixture.mjs`: runs in a hidden Electron window, so the
// editor code sees a real DOM. It parses the fixture markdown with each schema, seeds an
// editor through Yjs the way a room does (so autolink sees the sync), then reads the
// rendered DOM, the one serializer's markdown and both copy flavors.

import { Editor } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import { Markdown } from '@tiptap/markdown'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'
import * as Y from 'yjs'
import { copyFlavors } from '../../src/renderer/src/editor/copy'
import { docToMarkdown, renderFragment } from '../../src/renderer/src/editor/markdown'
import { MARKED_OPTIONS, parseMarkdown, schemaExtensions, schemaFor, type EditorKind } from '../../src/renderer/src/editor/schema'
import { YDOC_FRAGMENT } from '../../src/shared/types/ydoc'

const FIXTURE = `### Configuração e boas práticas do \`AGENTS.md\`

- O arquivo \`AGENTS.md\` define as instruções do agente.
- O arquivo AGENTS.md define as instruções do agente.
- Veja README.md e package.json antes de editar config.ts.
- Um span com crase: \`\`a \`tick\` b\`\` e \`a<b>&c\`.

### Bare AGENTS.md

Leia [o site](https://example.com) e o [AGENTS.md](AGENTS.md).

\`\`\`
npm run build
cat AGENTS.md
\`\`\`
`

const MUST_KEEP = ['AGENTS.md', 'README.md', 'package.json', 'config.ts', 'npm run build', 'cat AGENTS.md', 'a `tick` b', 'a<b>&c']

interface Result {
  name: string
  ok: boolean
  detail?: string
}

const results: Result[] = []

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, ...(ok || detail === undefined ? {} : { detail }) })
}

function missing(text: string): string[] {
  return MUST_KEEP.filter((s) => !text.includes(s))
}

function links(editor: Editor): string[] {
  const out: string[] = []
  editor.state.doc.descendants((node) => {
    const link = node.marks.find((m) => m.type.name === 'link')
    if (node.isText && link) out.push(`${node.text} -> ${String(link.attrs['href'])}`)
  })
  return out
}

function seededEditor(kind: EditorKind, md: string): Editor {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment(YDOC_FRAGMENT)
  doc.transact(() => prosemirrorJSONToYXmlFragment(schemaFor(kind), parseMarkdown(kind, md), fragment))
  const element = document.createElement('div')
  document.body.appendChild(element)
  return new Editor({
    element,
    extensions: [
      ...schemaExtensions(kind),
      Markdown.configure({ markedOptions: { ...MARKED_OPTIONS }, indentation: { style: 'space', size: 2 } }),
      Collaboration.configure({ fragment })
    ]
  })
}

/** Text typed at the end of the document, one transaction like a keystroke run. */
function type(editor: Editor, text: string): void {
  const end = editor.state.doc.content.size - 1
  editor.view.dispatch(editor.state.tr.insertText(text, end))
}

async function run(): Promise<void> {
  for (const kind of ['panel', 'notes'] as const) {
    const json = parseMarkdown(kind, FIXTURE)
    const node = schemaFor(kind).nodeFromJSON(json)
    check(`${kind}: parsed document keeps every filename`, missing(node.textContent).length === 0, missing(node.textContent).join(', '))
    let codeMarks = 0
    node.descendants((n) => {
      if (n.marks.some((m) => m.type.name === 'code')) codeMarks++
    })
    check(
      `${kind}: inline code ${kind === 'panel' ? 'is' : 'is not'} a code mark`,
      kind === 'panel' ? codeMarks === 4 : codeMarks === 0,
      `code marks: ${codeMarks}`
    )

    const editor = seededEditor(kind, FIXTURE)
    await new Promise((r) => setTimeout(r, 50))
    const rendered = editor.view.dom.textContent ?? ''
    check(`${kind}: rendered editor keeps every filename`, missing(rendered).length === 0, missing(rendered).join(', '))
    const linked = links(editor)
    check(`${kind}: only the real link is a link`, linked.length === 1 && linked[0] === 'o site -> https://example.com', linked.join(' | '))

    const md = docToMarkdown(editor.state.doc)
    check(`${kind}: serialized markdown keeps every filename`, missing(md).length === 0, missing(md).join(', '))
    if (kind === 'panel') {
      check('panel: serialized markdown writes code spans', md.includes('`AGENTS.md`') && md.includes('``a `tick` b``'), md)
      check('panel: markdown round trip is stable', docToMarkdown(schemaFor(kind).nodeFromJSON(parseMarkdown(kind, md))) === md, md)
    }

    const html = renderFragment(editor.schema, editor.state.doc.content).innerHTML
    const copy = copyFlavors(html, { title: 'Aula', date: null, attendees: [] })
    const copiedHtmlText = new DOMParser().parseFromString(copy.html, 'text/html').body.textContent ?? ''
    check(`${kind}: copied text/plain keeps every filename`, missing(copy.text).length === 0, missing(copy.text).join(', '))
    check(`${kind}: copied text/html keeps every filename`, missing(copiedHtmlText).length === 0, missing(copiedHtmlText).join(', '))

    // Typing: a filename followed by a space stays text; a URL still auto-links.
    type(editor, ' AGENTS.md ')
    type(editor, 'https://example.org ')
    const typed = links(editor)
    check(`${kind}: typed AGENTS.md is not auto-linked`, !typed.some((l) => l.startsWith('AGENTS.md')), typed.join(' | '))
    check(`${kind}: typed https://example.org still auto-links`, typed.some((l) => l.startsWith('https://example.org')), typed.join(' | '))

    // Pasting over a selection: a bare filename stays text; a URL links the selection.
    const word = (text: string): void => {
      const end = editor.state.doc.content.size - 1
      type(editor, ` ${text}`)
      editor.commands.setTextSelection({ from: end + 1, to: end + 1 + text.length })
    }
    word('alvo')
    editor.view.pasteText('AGENTS.md')
    word('outro')
    editor.view.pasteText('https://example.net')
    const pasted = links(editor)
    check(`${kind}: AGENTS.md pasted over a selection is not linked`, !pasted.some((l) => l.endsWith('https://AGENTS.md')), pasted.join(' | '))
    check(`${kind}: a URL pasted over a selection still links it`, pasted.some((l) => l === 'outro -> https://example.net'), pasted.join(' | '))

    if (kind === 'panel') {
      console.log(`FIXTURE-MARKDOWN ${JSON.stringify(md)}`)
      console.log(`FIXTURE-COPY ${JSON.stringify(copy.text)}`)
    }
    editor.destroy()
  }
  console.log(`FIXTURE-RESULT ${JSON.stringify(results)}`)
}

run().catch((err: unknown) => console.log(`FIXTURE-RESULT ${JSON.stringify([{ name: 'fixture ran', ok: false, detail: String(err) }])}`))
