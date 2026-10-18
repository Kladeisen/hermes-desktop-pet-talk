// Real Chromium layout of the bot bubble: no half-visible lines, the step and timer always
// visible, the bubble just above its own pet and inside the 280x240 window.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(`${process.env.TALK_TEST_DEPS}/../package.json`)
const { chromium } = require('playwright-core')
const plugin = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const shared = plugin.split('// COMPANION_SHARED_BEGIN')[1].split('\n').slice(1).join('\n').split('// COMPANION_SHARED_END')[0]
const html = fs.readFileSync(new URL('../companion/botview.html', import.meta.url), 'utf8')
  .replaceAll('BOT_NONCE', 'n').replace('BOT_SCRIPT', () => 'window.webkit={messageHandlers:{companion:{postMessage(){}}}};\n' + shared + '\n' + fs.readFileSync(new URL('../companion/botview.js', import.meta.url), 'utf8'))

const long = 'Pet ping-pong 2/4 (Codex): answer Claude, ask one back about caches and CI'
const cases = {
  running: { row: 7, title: long, detail: "Working out Claude's riddle and checking the answer", since: Date.now() / 1000 - 95, tone: 'info' },
  stall: { row: 6, title: long, detail: 'No reply from model (6 retries)', since: Date.now() / 1000 - 4000, tone: 'wait' },
  done: { row: 3, title: 'Done: ' + long, detail: 'Answered: A null pointer, the billion-dollar mistake, and asked about caches.', since: null, tone: 'info' },
  short: { row: 8, title: '', detail: 'Thinking', since: Date.now() / 1000 - 3, tone: 'info' },
}

test('bot bubble layout in real Chromium', async t => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage({ viewport: { width: 280, height: 240 } })
    const errors = []; page.on('pageerror', e => errors.push(e.message))
    await page.setContent(html)
    const measure = async (progress, pet) => page.evaluate(([progress, pet]) => {
      window.botReceive({ generation: 'g', bot: { id: 'alpha', label: 'claude-thinkpad', status: '', chat: true, ...(pet ? { pet } : {}), ...(progress ? { progress } : {}) }, acks: {} })
      const r = el => { const b = document.querySelector(el).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height } }
      const box = document.querySelector('#status'), css = getComputedStyle(box)
      const part = id => { const el = document.querySelector('#' + id); return { ...r('#' + id), text: el.textContent, hidden: el.hidden || getComputedStyle(el).display === 'none', scroll: el.scrollWidth, client: el.clientWidth } }
      return { box: r('#status'), padTop: parseFloat(css.paddingTop), padBottom: parseFloat(css.paddingBottom), border: parseFloat(css.borderTopWidth),
        scrollH: box.scrollHeight, clientH: box.clientHeight, title: part('title'), detail: part('detail'), time: part('time'), line: r('#line'), lineHeight: parseFloat(css.lineHeight) }
    }, [progress, pet])
    const pet = { spriteId: 'a'.repeat(64), frameWidth: 192, frameHeight: 208, counts: [1, 1, 1, 1, 1, 1, 1, 1, 1], top: 23 }
    for (const [name, progress] of Object.entries(cases)) {
      await t.test(name, async () => {
        const m = await measure(progress, pet)
        const inner = { top: m.box.top + m.border + m.padTop - 0.5, bottom: m.box.bottom - m.border - m.padBottom + 0.5, left: m.box.left, right: m.box.right }
        assert.ok(m.scrollH <= m.clientH + 0.5, `nothing overflows vertically (${m.scrollH} > ${m.clientH})`)
        for (const id of ['title', 'detail', 'time']) {
          const p = m[id]; if (p.hidden || !p.text) continue
          assert.ok(p.height <= m.lineHeight * 1.25, `${id} is one line (${p.height}px)`)
          assert.ok(p.top >= inner.top && p.bottom <= inner.bottom, `${id} fully inside the box vertically`)
          assert.ok(p.left >= inner.left && p.right <= inner.right + 0.5, `${id} fully inside the box horizontally`)
        }
        if (progress.since) assert.ok(m.time.width > 10 && !m.time.hidden, 'timer is always visible')
        assert.ok(m.detail.width >= 40, `the step keeps room next to the timer (${m.detail.width}px)`)
        assert.ok(m.box.left >= 0 && m.box.right <= 280 && m.box.top >= 0, 'inside the window')
        assert.ok(m.box.bottom <= 90 + 23 / 2 && m.box.bottom >= 90 + 23 / 2 - 8, `bubble ends just above the head (${m.box.bottom})`)
        assert.ok(m.box.width <= 248.5, 'bounded width')
        if (name === 'stall') assert.ok(m.detail.scroll <= m.detail.client + 0.5, `the stall reason and retry count are never ellipsized (${m.detail.scroll} > ${m.detail.client})`)
      })
    }
    await t.test('short idle label gets a small bubble', async () => {
      const m = await measure(null, pet)
      assert.equal(m.detail.text, 'claude-thinkpad'); assert.ok(m.title.hidden)
      assert.ok(m.box.width < 140, `compact (${m.box.width}px)`)
      assert.ok(m.box.height < 32, `one line (${m.box.height}px)`)
    })
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})
