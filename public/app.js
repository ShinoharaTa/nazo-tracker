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

// SpoilerCard。「表示」で断片を取得して差し込み、「隠す」で DOM から消す（次に開くときは再取得）
const closeSpoiler = (toggle, body, veil) => {
  body.replaceChildren()
  body.hidden = true
  if (veil) veil.hidden = false
  toggle.textContent = '表示'
  toggle.setAttribute('aria-expanded', 'false')
}

const openSpoiler = async (toggle, body, veil) => {
  const card = toggle.closest('[data-spoiler]')
  card?.querySelector('.spoil-error')?.remove()
  toggle.setAttribute('aria-busy', 'true')
  toggle.setAttribute('aria-disabled', 'true')
  try {
    const res = await fetch(toggle.href, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'X-Requested-With': 'fetch' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    body.innerHTML = await res.text()
    body.hidden = false
    if (veil) veil.hidden = true
    toggle.textContent = '隠す'
    toggle.setAttribute('aria-expanded', 'true')
  } catch {
    const err = document.createElement('p')
    err.className = 'spoil-error note'
    err.setAttribute('role', 'alert')
    err.textContent = '読み込めませんでした'
    toggle.closest('.row')?.after(err)
  } finally {
    toggle.removeAttribute('aria-busy')
    toggle.removeAttribute('aria-disabled')
  }
}

document.addEventListener('click', (e) => {
  const target = e.target
  if (!(target instanceof Element)) return
  const toggle = target.closest('[data-spoiler-toggle]')
  if (!(toggle instanceof HTMLAnchorElement)) return
  e.preventDefault()
  if (toggle.getAttribute('aria-busy') === 'true') return
  const body = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
  if (!body) return
  const veil = toggle.closest('[data-spoiler]')?.querySelector('.veil') ?? null
  if (toggle.getAttribute('aria-expanded') === 'true') closeSpoiler(toggle, body, veil)
  else openSpoiler(toggle, body, veil)
})
