// SPDX-License-Identifier: Apache-2.0
// The permanent-delete confirmation: a modal native <dialog>, so
// focus stays inside it and Escape cancels. Only its danger button resolves true.

import './trash.css'

let open: Promise<boolean> | null = null

export function confirmDeletePermanently(): Promise<boolean> {
  // One dialog at a time; a second request joins the open one.
  if (open) return open
  open = new Promise<boolean>((resolve) => {
    const dialog = document.createElement('dialog')
    dialog.className = 'trash-dialog'
    dialog.setAttribute('aria-labelledby', 'trash-dialog-title')
    dialog.setAttribute('aria-describedby', 'trash-dialog-body')

    const title = document.createElement('h2')
    title.id = 'trash-dialog-title'
    title.className = 'trash-dialog__title'
    title.textContent = 'Permanently delete this note?'

    const body = document.createElement('p')
    body.id = 'trash-dialog-body'
    body.className = 'trash-dialog__body'
    body.textContent = 'The note and its transcript will be gone for good. You can’t undo this.'

    const actions = document.createElement('div')
    actions.className = 'trash-dialog__actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'n-btn'
    cancel.textContent = 'Cancel'
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'n-btn trash-dialog__danger'
    confirm.textContent = 'Delete permanently'
    actions.append(cancel, confirm)
    dialog.append(title, body, actions)

    let result = false
    const finish = (value: boolean): void => {
      result = value
      dialog.close()
    }
    cancel.addEventListener('click', () => finish(false))
    confirm.addEventListener('click', () => finish(true))
    // A click on the backdrop (the dialog box itself, outside its content) cancels.
    dialog.addEventListener('mousedown', (e) => {
      if (e.target === dialog) {
        const r = dialog.getBoundingClientRect()
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
        if (!inside) finish(false)
      }
    })
    dialog.addEventListener('close', () => {
      dialog.remove()
      open = null
      resolve(result)
    })
    document.body.append(dialog)
    dialog.showModal()
    cancel.focus()
  })
  return open
}
