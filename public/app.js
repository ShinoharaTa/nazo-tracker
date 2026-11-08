// dialog.sheet の開閉だけを受け持つ。ほかの画面操作はすべてリンクとフォームで行う。
document.addEventListener('click', (e) => {
  const target = e.target
  if (!(target instanceof Element)) return

  const opener = target.closest('[data-open]')
  if (opener) {
    const dialog = document.getElementById(opener.getAttribute('data-open') ?? '')
    if (dialog instanceof HTMLDialogElement) dialog.showModal()
    return
  }

  const closer = target.closest('[data-close]')
  if (closer) {
    closer.closest('dialog')?.close()
    return
  }

  // backdrop のクリック。target が dialog 自身になるが、dialog の余白部分も同じ target になるので矩形の外側かも見る
  if (target instanceof HTMLDialogElement && target.open) {
    const r = target.getBoundingClientRect()
    const inside =
      e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    if (!inside) target.close()
  }
})
