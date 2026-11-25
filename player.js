// The demo player (#442). Compiles an edition's timeline.json (capture.mjs)
// into a fixed timeline, where every caption, cursor move, typed character and
// screen change has its time, and renders any moment of it: render(t) depends
// only on t, so playing, scrubbing, ?t= links and stills agree.
// The screens are snapshots of the real app shown in iframes at 1.5x on a
// 1920x1080 stage; everything on top of them is drawn here.
(() => {
  /** How long things take (ms). Tune the demo's pace here. */
  const PACING = {
    open: 3600, // the opening card
    card: 3000, // each chapter's title card
    close: 4500, // the closing card
    cardFade: 600,
    swap: 180, // a beat after the next screen comes in
    scroll: 850,
    glide: 650, // the cursor moving to what it clicks
    press: 220,
    afterClick: 320, // a beat before the next screen
    typeChar: 55,
    afterType: 350,
    choose: 600,
    holdScale: 0.85, // each caption's hold (from script.mjs) times this
    captionFade: 250,
    // a caption stays up at least long enough to read: this many words a
    // second, plus a moment to notice it (review.mjs checks the same)
    readWps: 3,
    readNotice: 800,
  };
  // the app's window on the stage: snapshots (laid out at 1280x720) drawn at
  // 1.3x, with the branded background around it and a caption band below,
  // so captions never cover the app. Keep in step with #screens in style.css
  const APP = { x: 128, y: 22, scale: 1.3 };
  const STAGE = { w: 1920, h: 1080 };
  const EDITIONS = [
    { key: 'production', label: 'Live today' },
    { key: 'alpha', label: 'Coming soon' },
  ];

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const EXPORT = params.get('export') === '1';
  const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const mmss = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    n.append(...kids);
    return n;
  };

  /** The timeline's segments, with their times */
  function compile(tl) {
    const segs = {
      card: [],
      screen: [],
      scroll: [],
      caption: [],
      cursor: [],
      ring: [],
      type: [],
      choose: [],
    };
    const chapters = [];
    let t = 0;
    // the last cursor move: the next one starts where it ended
    let lastCursor = null;
    segs.card.push({
      t0: 0,
      t1: PACING.open,
      k: 'A guided tour',
      title: tl.title,
      sub: tl.tagline,
      first: true,
    });
    t = PACING.open;
    tl.chapters.forEach((ch, i) => {
      const start = t;
      segs.card.push({
        t0: t,
        t1: t + PACING.card,
        k: `Chapter ${i + 1}`,
        title: ch.title,
        sub: ch.summary,
      });
      segs.caption.push({ t0: t, text: '' });
      t += PACING.card;
      let screen = null;
      let scroll = 0;
      // the caption on screen: the next one (or the chapter's end) waits
      // until it's been up long enough to read
      let caption = null;
      const readable = () => {
        if (!caption) return;
        const words = caption.text.split(/\s+/).length;
        const need = (words / PACING.readWps) * 1000 + PACING.readNotice;
        t = Math.max(t, caption.t0 + need);
      };
      // where capture saw a target, on the stage: only a fallback, since
      // the player finds it in the snapshot by its path (boxOf)
      const toStage = (at) => ({
        x: APP.x + at.x * APP.scale,
        y: APP.y + (at.y - scroll) * APP.scale,
        w: at.w * APP.scale,
        h: at.h * APP.scale,
      });
      const glide = (at) => {
        const seg = {
          t0: t,
          t1: t + PACING.glide,
          prev: lastCursor,
          screen,
          path: at.path,
          fallback: toStage(at),
        };
        lastCursor = seg;
        return seg;
      };
      for (const e of ch.events) {
        if (e.do === 'show') {
          // a chapter's first screen goes in under its title card
          const t0 = screen ? t : start + PACING.cardFade;
          segs.screen.push({
            t0,
            screen: e.screen,
            scroll: e.scroll,
            inner: e.inner ?? [],
            chapter: i,
          });
          if (screen) t += PACING.swap;
          screen = e.screen;
          scroll = e.scroll;
        } else if (e.do === 'scroll') {
          segs.scroll.push({
            t0: t,
            t1: t + PACING.scroll,
            from: scroll,
            to: e.to,
            screen,
          });
          scroll = e.to;
          t += PACING.scroll;
        } else if (e.do === 'say') {
          readable();
          segs.caption.push({ t0: t, text: e.text });
          caption = { t0: t, text: e.text };
          t += e.hold * PACING.holdScale;
        } else if (e.do === 'click') {
          const g = glide(e.at);
          g.press = g.t1;
          g.t1 = g.press + PACING.press;
          segs.cursor.push(g);
          t = g.t1 + PACING.afterClick;
        } else if (e.do === 'type') {
          const g = glide(e.at);
          segs.cursor.push(g);
          const t0 = g.t1;
          const t1 = t0 + e.text.length * PACING.typeChar;
          segs.type.push({ t0, t1, screen, path: e.at.path, text: e.text });
          t = t1 + PACING.afterType;
        } else if (e.do === 'choose') {
          const g = glide(e.at);
          g.press = g.t1;
          g.t1 = g.press + PACING.press;
          segs.cursor.push(g);
          segs.choose.push({
            t0: g.press,
            screen,
            path: e.at.path,
            label: e.label,
          });
          t = g.t1 + PACING.choose;
        } else if (e.do === 'highlight') {
          const hold = e.hold * PACING.holdScale;
          segs.ring.push({
            t0: t,
            t1: t + hold,
            screen,
            path: e.at.path,
            fallback: toStage(e.at),
          });
          t += hold;
        }
      }
      readable();
      t += 400;
      chapters.push({
        id: ch.id,
        title: ch.title,
        summary: ch.summary,
        startMs: start,
        endMs: t,
      });
    });
    segs.card.push({
      t0: t,
      t1: t + PACING.close,
      k: 'Thank you',
      title: tl.title,
      sub: tl.tagline,
      last: true,
    });
    segs.caption.push({ t0: t, text: '' });
    t += PACING.close;
    return { segs, chapters, duration: t };
  }

  // ---- screens: one iframe per snapshot, kept near the current time ----
  let base = '';
  const frames = new Map();
  function frame(id) {
    let f = frames.get(id);
    if (f) return f;
    const iframe = el('iframe', { title: '', tabIndex: -1 });
    iframe.setAttribute('aria-hidden', 'true');
    const ready = new Promise((resolve) => {
      iframe.addEventListener(
        'load',
        () => {
          try {
            // snapshots are still: animations jump to how they end (a toast's
            // check mark drawn), no transitions, carets or scrollbars
            const doc = iframe.contentDocument;
            doc.head.append(
              el('style', {
                textContent:
                  '*,*::before,*::after{animation-delay:-60s!important;animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}html{scrollbar-width:none}::-webkit-scrollbar{display:none}',
              }),
            );
          } catch {
            /* opened from file://: still shows, no typing */
          }
          f.loaded = true;
          resolve();
        },
        { once: true },
      );
    });
    iframe.src = `${base}/screens/${id}.html`;
    f = { iframe, ready, loaded: false, values: new Map() };
    frames.set(id, f);
    $('screens').append(iframe);
    return f;
  }
  function dropFrames() {
    for (const f of frames.values()) f.iframe.remove();
    frames.clear();
  }

  let film = null; // { segs, chapters, duration, edition, timeline }
  let t = 0;

  const lastBefore = (list, time) => {
    let found = null;
    for (const s of list) {
      if (s.t0 <= time) found = s;
      else break;
    }
    return found;
  };

  /** The screens at a time: the current one, and the one shown before it */
  // a screen up for less than this is a capture between two steps (the page
  // mid-update): showing it flickers, so the screen before stays instead
  const MIN_SCREEN_MS = 300;
  const shownScreens = new WeakMap();
  function screensAt(time) {
    let list = shownScreens.get(film);
    if (!list) {
      const all = film.segs.screen;
      list = all.filter(
        (s, i) => !all[i + 1] || all[i + 1].t0 - s.t0 >= MIN_SCREEN_MS,
      );
      shownScreens.set(film, list);
    }
    let i = -1;
    for (let j = 0; j < list.length; j++) if (list[j].t0 <= time) i = j;
    const cur = list[i] || list[0];
    const prev = i > 0 ? list[i - 1] : null;
    return { cur, prev, fade: cur ? clamp((time - cur.t0) / PACING.swap) : 1 };
  }

  /** A screen's scroll position at a time, from its scroll segments */
  function scrollAt(seg, time) {
    let y = seg.scroll;
    for (const s of film.segs.scroll) {
      if (s.t0 < seg.t0 || s.screen !== seg.screen || s.t0 > time) continue;
      y =
        time >= s.t1
          ? s.to
          : s.from + (s.to - s.from) * ease((time - s.t0) / (s.t1 - s.t0));
    }
    return y;
  }

  /** Typing and choices made on a screen, as they stand at a time */
  function patchFields(seg, time) {
    const f = frames.get(seg.screen);
    if (!f?.loaded) return;
    let doc;
    try {
      doc = f.iframe.contentDocument;
    } catch {
      return;
    }
    const apply = (path, set) => {
      const node = doc.querySelector(path);
      if (!node) return;
      if (!f.values.has(path)) f.values.set(path, node.value);
      set(node, f.values.get(path));
    };
    for (const s of film.segs.type) {
      if (s.screen !== seg.screen) continue;
      apply(s.path, (n, orig) => {
        if (time < s.t0) n.value = orig;
        else
          n.value = s.text.slice(
            0,
            Math.ceil(
              clamp((time - s.t0) / Math.max(1, s.t1 - s.t0)) * s.text.length,
            ),
          );
      });
    }
    for (const s of film.segs.choose) {
      if (s.screen !== seg.screen) continue;
      apply(s.path, (n, orig) => {
        if (time < s.t0) n.value = orig;
        else {
          const o = [...n.options].find((x) => x.text === s.label);
          if (o) n.value = o.value;
        }
      });
    }
  }

  // pre-loads the screens shown around a time, and lets go of far ones
  function keepNear(time) {
    const want = new Set();
    for (const s of film.segs.screen)
      if (s.t0 > time - 4000 && s.t0 < time + 15000) want.add(s.screen);
    const { cur, prev } = screensAt(time);
    if (cur) want.add(cur.screen);
    if (prev) want.add(prev.screen);
    for (const id of want) frame(id);
    for (const [id, f] of frames)
      if (!want.has(id)) {
        f.iframe.remove();
        frames.delete(id);
      }
    return want;
  }

  function cardHtml(c) {
    const card = $('card');
    if (card.dataset.key === c.title + c.k) return;
    card.dataset.key = c.title + c.k;
    card.replaceChildren(
      el(
        'div',
        { className: 'brand' },
        el('img', { src: 'favicon.png', alt: '' }),
        'Paradise Payments',
      ),
      el('div', { className: 'k', textContent: c.k }),
      el('div', { className: 't', textContent: c.title }),
      el('div', { className: 'bar' }),
      el('div', { className: 's', textContent: c.sub || '' }),
      ...(c.last && film.timeline.music
        ? [
            el('div', {
              className: 'm',
              textContent: `Music: ${film.timeline.music}`,
            }),
          ]
        : []),
    );
  }

  /**
   * Where a target is on the stage now: found in its snapshot by path, so it
   * follows whatever the snapshot shows (its scroll, a dialog); capture's
   * coordinates only if the snapshot isn't loaded.
   */
  function boxOf(seg) {
    const f = frames.get(seg.screen);
    if (f?.loaded && seg.path) {
      try {
        const node = f.iframe.contentDocument.querySelector(seg.path);
        if (node) {
          const r = node.getBoundingClientRect();
          return {
            x: APP.x + r.left * APP.scale,
            y: APP.y + r.top * APP.scale,
            w: r.width * APP.scale,
            h: r.height * APP.scale,
          };
        }
      } catch {
        /* file:// */
      }
    }
    return seg.fallback;
  }
  const centerOf = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  // where the cursor rests before its first move
  const PARK = { x: 1500, y: 760 };

  /** Draws the stage as it is at `time` (ms) */
  function render(time) {
    if (!film) return;
    t = Math.max(0, Math.min(time, film.duration));
    keepNear(t);
    const { cur, prev } = screensAt(t);
    // the app never blanks or double-exposes: the next screen replaces the
    // last at once, like a page updating in place. One that hasn't loaded
    // yet waits, with the last one still shown.
    const ready = !!(cur && frames.get(cur.screen)?.loaded);
    const showing = ready || !prev ? cur?.screen : prev.screen;
    for (const [id, f] of frames) {
      const on = id === showing;
      f.iframe.style.visibility = on ? 'visible' : 'hidden';
      f.iframe.style.opacity = on ? '1' : '0';
    }
    for (const seg of [prev, cur]) {
      if (!seg) continue;
      const f = frames.get(seg.screen);
      if (!f?.loaded) continue;
      const at = seg === prev ? cur.t0 : t;
      try {
        f.iframe.contentWindow.scrollTo(0, scrollAt(seg, at));
      } catch {
        /* file:// */
      }
      patchFields(seg, at);
      // scrolled areas inside the page (a carousel, a dialog's body)
      for (const s of seg.inner) {
        try {
          const node = f.iframe.contentDocument.querySelector(s.path);
          if (node) {
            node.scrollTop = s.top;
            node.scrollLeft = s.left;
          }
        } catch {
          /* file:// */
        }
      }
    }

    // title cards
    const card =
      film.segs.card.find((c) => t >= c.t0 && t < c.t1) ||
      (t >= film.duration ? film.segs.card.at(-1) : null);
    if (card) {
      cardHtml(card);
      // back-to-back cards (the opening card, then chapter 1's) share one
      // background: only their words fade, so no screen shows in between
      const i = film.segs.card.indexOf(card);
      const after = film.segs.card[i - 1]?.t1 === card.t0;
      const before = film.segs.card[i + 1]?.t0 === card.t1;
      const fin = clamp((t - card.t0) / PACING.cardFade);
      const fout = clamp((card.t1 - t) / PACING.cardFade);
      const bgIn = card.first || after ? 1 : fin;
      const bgOut = card.last || before ? 1 : fout;
      $('card').style.opacity = String(Math.min(bgIn, bgOut));
      const words = Math.min(after ? fin : 1, before ? fout : 1);
      $('card').style.setProperty('--words', String(words));
    } else $('card').style.opacity = '0';

    // the caption
    const cap = lastBefore(film.segs.caption, t);
    const capEl = $('caption');
    if (cap?.text) {
      if (capEl.textContent !== cap.text) capEl.textContent = cap.text;
      capEl.style.opacity = String(clamp((t - cap.t0) / PACING.captionFade));
    } else capEl.style.opacity = '0';

    // highlight rings
    const ring = film.segs.ring.find((r) => t >= r.t0 && t < r.t1);
    const ringEl = $('ring');
    if (ring) {
      const b = boxOf(ring);
      Object.assign(ringEl.style, {
        left: `${b.x - 9}px`,
        top: `${b.y - 9}px`,
        width: `${b.w + 18}px`,
        height: `${b.h + 18}px`,
        opacity: String(
          Math.min(clamp((t - ring.t0) / 200), clamp((ring.t1 - t) / 200)),
        ),
      });
    } else ringEl.style.opacity = '0';

    // the cursor: only while it's going to click, type or choose
    const c = film.segs.cursor.find((s) => t >= s.t0 && t < s.t1 + 300);
    const curEl = $('cursor');
    if (c) {
      const to = centerOf(boxOf(c));
      // remembered once the target's on screen, so the next move starts there
      if (t >= c.t1) c.end = to;
      const from = c.prev ? (c.prev.end ?? centerOf(c.prev.fallback)) : PARK;
      const p = ease(clamp((t - c.t0) / PACING.glide));
      const x = from.x + (to.x - from.x) * p;
      const y = from.y + (to.y - from.y) * p;
      const pressing =
        c.press != null && t >= c.press && t < c.press + PACING.press;
      curEl.style.left = `${x}px`;
      curEl.style.top = `${y}px`;
      curEl.style.transform = pressing ? 'scale(0.7)' : 'none';
      curEl.style.opacity = String(
        Math.min(clamp((t - c.t0) / 150), clamp((c.t1 + 300 - t) / 300)),
      );
    } else curEl.style.opacity = '0';

    updateUi();
  }

  /** For the exporter: renders a time once its screens have loaded */
  async function seek(time) {
    render(time);
    const { cur, prev } = screensAt(t);
    await Promise.all(
      [cur, prev].filter(Boolean).map((s) => frame(s.screen).ready),
    );
    render(time);
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
  }

  // ---- playback ----
  let playing = false;
  let lastTick = 0;
  const music = $('music');
  function play() {
    if (!film) return;
    if (t >= film.duration) t = 0;
    playing = true;
    lastTick = performance.now();
    syncMusic(true);
    requestAnimationFrame(tick);
    updateUi();
  }
  function pause() {
    playing = false;
    music.pause();
    updateUi();
  }
  function tick(now) {
    if (!playing) return;
    t += (now - lastTick) * Number($('speed').value);
    lastTick = now;
    if (t >= film.duration) {
      t = film.duration;
      playing = false;
      music.pause();
    }
    render(t);
    if (playing) requestAnimationFrame(tick);
  }
  function syncMusic(force) {
    if (!film?.timeline.musicFile || EXPORT) return;
    if (!playing || music.muted) return music.pause();
    music.playbackRate = Number($('speed').value);
    if (force || Math.abs(music.currentTime - t / 1000) > 0.3)
      music.currentTime = t / 1000;
    music.play().catch(() => {});
  }
  function goTo(ms) {
    render(ms);
    if (playing) syncMusic(true);
  }

  // ---- the page around the stage ----
  const manifests = {};
  let edition = 'production';
  const chapterAt = (ms) => {
    const chs = film.chapters;
    let i = 0;
    while (i + 1 < chs.length && chs[i + 1].startMs <= ms) i++;
    return i;
  };
  function setUrl({ scene, time } = {}) {
    if (EXPORT) return;
    const q = new URLSearchParams();
    q.set('edition', edition);
    if (scene) q.set('scene', scene);
    if (time != null) q.set('t', (time / 1000).toFixed(1));
    if (document.body.classList.contains('clean')) q.set('clean', '1');
    history.replaceState(null, '', `?${q}`);
  }
  let shownChapter = -1;
  function updateUi() {
    if (!film || EXPORT) return;
    $('time').textContent = `${mmss(t)} / ${mmss(film.duration)}`;
    $('scrub').value = String(Math.round((t / film.duration) * 1000));
    $('play').classList.toggle('playing', playing);
    $('play').ariaLabel = playing ? 'Pause' : 'Play';
    // over the demo whenever it's paused (at the start, or paused with the
    // play button, a click on the demo or the end), gone while it plays
    $('bigplay').hidden = playing;
    const chs = film.chapters;
    [...$('bar').children].forEach((b, i) => {
      const { startMs: a, endMs: z } = chs[i];
      b.firstChild.style.width = `${t >= z ? 100 : t <= a ? 0 : ((t - a) / (z - a)) * 100}%`;
    });
    const cur = chapterAt(t);
    if (cur !== shownChapter) {
      shownChapter = cur;
      [...$('list').children].forEach((li, i) =>
        li.firstChild.setAttribute('aria-current', String(i === cur)),
      );
      $('title').textContent = `${cur + 1}. ${chs[cur].title}`;
      $('summary').textContent = chs[cur].summary;
    }
  }
  function renderTabs() {
    $('tabs').replaceChildren(
      ...EDITIONS.filter(({ key }) => manifests[key]).map(({ key, label }) =>
        el('button', {
          role: 'tab',
          type: 'button',
          className: 'pill',
          textContent: label,
          ariaSelected: String(edition === key),
          onclick: () => {
            load(key);
            setUrl();
          },
        }),
      ),
    );
  }
  function load(key, at) {
    pause();
    edition = key;
    base = key;
    dropFrames();
    const tl = manifests[key];
    film = { ...compile(tl), timeline: tl };
    shownChapter = -1;
    renderTabs();
    $('player').hidden = false;
    $('status').hidden = true;
    // the soundtrack (WebM/Opus, faded to the demo's length); browsers that
    // can't play that (older Safari) get the original track, looped
    const webm = music.canPlayType('audio/webm; codecs=opus') !== '';
    music.loop = !webm;
    music.src = !tl.musicFile
      ? ''
      : webm
        ? `${key}/${tl.musicFile}`
        : 'music.mp3';
    const lens = film.chapters.map((c) => c.endMs - c.startMs);
    $('bar').replaceChildren(
      ...film.chapters.map((c, i) =>
        el(
          'button',
          {
            type: 'button',
            title: `${i + 1}. ${c.title} (${mmss(lens[i])})`,
            ariaLabel: `Chapter ${i + 1}: ${c.title}`,
            style: `flex-grow:${lens[i]}`,
            onclick: () => toChapter(i),
          },
          el('span'),
        ),
      ),
    );
    $('list').replaceChildren(
      ...film.chapters.map((c, i) =>
        el(
          'li',
          {},
          el(
            'button',
            { type: 'button', onclick: () => toChapter(i) },
            el('span', { className: 'tt', textContent: mmss(c.startMs) }),
            el(
              'span',
              {},
              el(
                'span',
                { className: 'ct' },
                c.title,
                el('span', { className: 'len', textContent: mmss(lens[i]) }),
              ),
              el('span', { className: 'cs', textContent: c.summary }),
            ),
          ),
        ),
      ),
    );
    $('listTitle').textContent = `Chapters · ${mmss(film.duration)}`;
    $('meta').replaceChildren(
      `Recorded ${new Date(tl.recordedAt).toLocaleDateString()}`,
      ...(tl.music ? [` · Music: ${tl.music}`] : []),
    );
    render(at ?? 0);
  }
  function toChapter(i) {
    const c = film.chapters[i];
    setUrl({ scene: c.id });
    goTo(c.startMs);
    if (!playing) play();
  }

  function fit() {
    const box = $('frame').getBoundingClientRect();
    const s = Math.min(box.width / STAGE.w, box.height / STAGE.h);
    const x = (box.width - STAGE.w * s) / 2;
    const y = (box.height - STAGE.h * s) / 2;
    $('stage').style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  }
  addEventListener('resize', fit);

  $('frame').addEventListener('click', () => (playing ? pause() : play()));
  $('exit').addEventListener('click', (e) => {
    e.stopPropagation();
    if (document.fullscreenElement) document.exitFullscreen();
    document.body.classList.remove('clean');
    fit();
  });
  $('play').addEventListener('click', () => (playing ? pause() : play()));
  $('scrub').addEventListener('input', (e) => {
    goTo((Number(e.target.value) / 1000) * film.duration);
  });
  $('speed').addEventListener('change', () => syncMusic(true));
  $('mute').addEventListener('click', () => {
    music.muted = !music.muted;
    $('mute').setAttribute('aria-pressed', String(!music.muted));
    syncMusic(true);
  });
  // full screen; where only videos can go full screen (iPhone), the player
  // fills the window instead (H, or the button again, to go back)
  $('full').addEventListener('click', () => {
    const f = $('frame');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (f.requestFullscreen) f.requestFullscreen().catch(() => {});
    else {
      document.body.classList.toggle('clean');
      fit();
    }
  });
  document.addEventListener('fullscreenchange', fit);
  $('copy').addEventListener('click', async () => {
    setUrl({ time: t });
    try {
      await navigator.clipboard.writeText(location.href);
      $('copy').textContent = 'Link copied';
    } catch {
      $('copy').textContent = 'Copy the address bar';
    }
    setTimeout(
      () => ($('copy').textContent = 'Copy link to this moment'),
      2000,
    );
  });
  addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, select, textarea')) return;
    if (e.key === ' ') {
      e.preventDefault();
      playing ? pause() : play();
    } else if (e.key === 'ArrowLeft') goTo(t - 2000);
    else if (e.key === 'ArrowRight') goTo(t + 2000);
    else if (e.key === 'h' || e.key === 'H') {
      document.body.classList.toggle('clean');
      fit();
    }
  });

  if (params.get('clean') === '1' || EXPORT)
    document.body.classList.add('clean');
  if (EXPORT) {
    $('bigplay').remove();
    $('exit').remove();
  }
  fit();
  Promise.all(
    EDITIONS.map(({ key }) =>
      fetch(`${key}/timeline.json`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((m) => {
          if (m) manifests[key] = m;
        }),
    ),
  ).then(() => {
    const [hashEd, hashScene] = location.hash.slice(1).split('/');
    const ed = params.get('edition') || hashEd;
    const first = manifests[ed]
      ? ed
      : EDITIONS.find(({ key }) => manifests[key])?.key;
    if (!first) {
      $('status').textContent = 'The demo hasn’t been captured yet.';
      return;
    }
    const tl = manifests[first];
    const sceneId = params.get('scene') || hashScene;
    const sceneIdx = tl.chapters.findIndex((c) => c.id === sceneId);
    load(first);
    fit();
    const at = params.get('t');
    if (at != null) render(Number(at) * 1000);
    else if (sceneIdx >= 0) render(film.chapters[sceneIdx].startMs);
    if (at == null && params.get('autoplay') === '1') {
      music.muted = true;
      play();
    }
    // for the exporter and for checking frames
    // every moment something is clicked, typed in or circled (export.mjs --actions)
    const actions = [
      ...film.segs.cursor.map((c) => ({ ms: c.press ?? c.t1, kind: 'cursor' })),
      ...film.segs.ring.map((r) => ({ ms: (r.t0 + r.t1) / 2, kind: 'ring' })),
    ].sort((a, b) => a.ms - b.ms);
    // each caption and how long it's up (review.mjs checks they can be read)
    const caps = film.segs.caption;
    const captions = caps
      .map((c, i) => ({
        text: c.text,
        ms: (caps[i + 1]?.t0 ?? film.duration) - c.t0,
      }))
      .filter((c) => c.text);
    window.__demo = {
      actions,
      // when each screen comes in (for checking the swaps)
      swaps: film.segs.screen.map((s) => ({ ms: s.t0, screen: s.screen })),
      captions,
      duration: film.duration,
      seek,
      render,
      chapters: film.chapters,
      ready: true,
    };
  });
})();
