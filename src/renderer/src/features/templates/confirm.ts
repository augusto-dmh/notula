// SPDX-License-Identifier: Apache-2.0
// A modal confirmation as a native <dialog> (focus stays inside, Escape cancels), in
// the regenerate dialog's style. Used for "Delete template" and the
// section delete. Resolves true only on the confirm button.

import '../enhance/enhance.css'

export function confirmDialog(opts: { title: string; body: string; confirmLabel: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog')
    dialog.className = 'enh-dialog tpl-confirm'
    const titleId = `tpl-confirm-title-${crypto.randomUUID()}`
    const bodyId = `${titleId}-body`
    dialog.setAttribute('aria-labelledby', titleId)
    dialog.setAttribute('aria-describedby', bodyId)

    const title = document.createElement('h2')
    title.id = titleId
    title.className = 'enh-dialog__title'
    title.textContent = opts.title
    const body = document.createElement('p')
    body.id = bodyId
    body.className = 'enh-dialog__body'
    body.textContent = opts.body
    const actions = document.createElement('div')
    actions.className = 'enh-dialog__actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'n-btn'
    cancel.textContent = 'Cancel'
    const ok = document.createElement('button')
    ok.type = 'button'
    ok.className = opts.danger ? 'n-btn enh-btn--danger' : 'n-btn n-btn--primary'
    ok.textContent = opts.confirmLabel
    actions.append(cancel, ok)
    dialog.append(title, body, actions)

    let result = false
    const finish = (value: boolean): void => {
      result = value
      if (dialog.open) dialog.close()
    }
    cancel.addEventListener('click', () => finish(false))
    ok.addEventListener('click', () => finish(true))
    dialog.addEventListener('mousedown', (e) => {
      if (e.target !== dialog) return
      const r = dialog.getBoundingClientRect()
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) finish(false)
    })
    // Escape on this dialog must not also close a dialog underneath it.
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') e.stopPropagation()
    })
    dialog.addEventListener('close', () => {
      dialog.remove()
      resolve(result)
    })
    document.body.append(dialog)
    dialog.showModal()
    cancel.focus()
  })
}
