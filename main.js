(() => {
  'use strict';

  /* =====================================================================
     НАСТРОЙКИ
     Прыжок — один непрерывный ролик: камера напротив героя и падает вместе
     с ним вдоль фасада, в конце сальто и стог. Каждый кадр ролика ключевой,
     поэтому перемотка колесом мгновенная. Ролик целиком грузится в память
     до начала (с процентами на экране), дальше сеть не нужна.
     На вертикальном телефоне — лёгкая версия: центр кадра 640×1080.
     ===================================================================== */
  const PHONE = innerHeight > innerWidth;
  const SRC = {
    idle: PHONE ? 'video/idle2-m.mp4?v=5' : 'video/idle2.mp4?v=5',
    leap: PHONE ? 'video/leap-m.mp4?v=5' : 'video/leap.mp4?v=5',
  };

  // ключевые моменты прокрутки (доля от 0 до 1)
  const T = {
    start: 0.03,   // начало прыжка
    end: 0.97,     // ролик доигран
    impact: 0.735, // удар в стог: 7,5 с из 10 с ролика
  };

  /* ================= утилиты ================= */

  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const seg = (p, a, b) => clamp((p - a) / (b - a), 0, 1);
  const eIO = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const r2 = (n) => Math.round(n * 100) / 100;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const el = {
    cam: $('#cam'),
    leap: $('#leap'),
    idle: $('#idle'),
    fx: $('#fx'),
    rays: $('#rays'),
    flash: $('#flash'),
    syncFill: $('#syncFill'),
    hint: $('#hint'),
    legal: $('#legal'),
    title: $('#title'),
    loadPct: $('#loadPct'),
    curtainPct: $('#curtainPct'),
    panels: [...document.querySelectorAll('.panel')],
  };

  // заголовок по буквам — для анимации появления
  el.title.innerHTML = [...el.title.textContent]
    .map((ch, i) => `<span class="ch" style="--i:${i}">${ch === ' ' ? ' ' : ch}</span>`)
    .join('');

  // «моменты» полёта: пока видна панель .beat, кадр слегка размыт и притемнён
  const beats = [...document.querySelectorAll('.panel.beat')].map((n) => [+n.dataset.in, +n.dataset.out]);
  const beatAmount = (p) =>
    Math.max(0, ...beats.map(([a, b]) => Math.min(eIO(seg(p, a - 0.01, a + 0.025)), 1 - eIO(seg(p, b - 0.025, b + 0.01)))));

  /* ================= загрузка ================= */

  // ролик скачиваем целиком в память: перемотка не ждёт сеть
  async function fetchWithProgress(url, onProgress) {
    const res = await fetch(url);
    const total = +res.headers.get('content-length') || 0;
    if (!res.body || !total) return URL.createObjectURL(await res.blob());
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(got / total);
    }
    return URL.createObjectURL(new Blob(chunks, { type: 'video/mp4' }));
  }

  const once = (node, ev, ms) =>
    new Promise((res) => {
      node.addEventListener(ev, res, { once: true });
      setTimeout(res, ms);
    });

  // главный экран показываем, как только готов цикл; прыжок докачивается в фоне.
  // Пока он качается, видео подгружается кусками по ходу прокрутки, а когда скачано
  // целиком — тихо переключаемся на копию в памяти.
  const ready = (v, ms) =>
    new Promise((res) => {
      if (v.readyState >= 2) return res('ok');
      const ok = () => { clean(); res('ok'); };
      const bad = () => { clean(); res('err'); };
      const clean = () => { v.removeEventListener('loadeddata', ok); v.removeEventListener('error', bad); };
      v.addEventListener('loadeddata', ok);
      v.addEventListener('error', bad);
      setTimeout(() => { clean(); res(v.readyState >= 2 ? 'ok' : 'timeout'); }, ms);
    });

  // ставим ролик из памяти, а если браузер (Safari) его не открыл — по обычной ссылке, он уже в кэше
  async function setLeapSource(blobUrl) {
    if (blobUrl) {
      el.leap.src = blobUrl;
      if ((await ready(el.leap, 8000)) === 'ok') return;
    }
    el.leap.src = SRC.leap;
    await ready(el.leap, 10000);
  }

  // iPhone не показывает кадры при перемотке, пока видео хоть раз не запущено
  async function prime(v) {
    try { await v.play(); v.pause(); } catch (e) { /* автозапуск запрещён — повторим по касанию */ }
  }

  async function loadMedia() {
    el.idle.src = SRC.idle;
    el.idle.play().catch(() => {});
    if (PHONE) {
      let blob = null;
      try {
        blob = await fetchWithProgress(SRC.leap, (k) => {
          el.curtainPct.textContent = `Загрузка ${Math.round(k * 100)}%`;
        });
      } catch (e) { /* не скачалось — возьмём по ссылке */ }
      el.leap.preload = 'auto';
      await setLeapSource(blob);
      await prime(el.leap);
      el.leap.currentTime = 0;
      el.curtainPct.textContent = '';
      return;
    }
    el.leap.preload = 'auto';
    el.leap.src = SRC.leap;
    await Promise.all([once(el.idle, 'loadeddata', 4000), once(el.leap, 'loadedmetadata', 4000)]);
  }

  async function loadLeapToMemory() {
    const url = await fetchWithProgress(SRC.leap, (k) => {
      el.loadPct.textContent = `Загрузка прыжка ${Math.round(k * 100)}%`;
    });
    const t = el.leap.currentTime;
    await setLeapSource(url);
    el.leap.currentTime = t;
    el.loadPct.textContent = '';
  }

  /* ================= эффекты: пыль и линии скорости ================= */

  const fctx = el.fx.getContext('2d');
  let W = 0, H = 0, dpr = 1, motes = [];

  function resize() {
    dpr = Math.min(2, devicePixelRatio || 1);
    W = innerWidth;
    H = innerHeight;
    el.fx.width = Math.round(W * dpr);
    el.fx.height = Math.round(H * dpr);
    motes = Array.from({ length: W < 760 ? 40 : 80 }, () => ({
      x: Math.random() * W, y: Math.random() * H, z: 0.3 + Math.random() * 1.2, ph: Math.random() * 6.3,
    }));
  }

  function drawFx(p, t, dt, speed) {
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fctx.clearRect(0, 0, W, H);
    const streak = clamp(speed, 0, 1);
    fctx.globalCompositeOperation = 'lighter';
    fctx.lineCap = 'round';
    for (const m of motes) {
      m.x += (6 + mouse.x * 4) * m.z * dt;
      m.y += (-8 * m.z - speed * 2600 * m.z) * dt;
      if (m.y < -60) { m.y = H + 20; m.x = Math.random() * W; }
      if (m.x > W + 20) m.x = -20;
      if (streak > 0.05) {
        if (Math.abs(m.x - W / 2) < W * 0.12) continue;
        const len = 20 + streak * 240 * m.z;
        const g = fctx.createLinearGradient(0, m.y, 0, m.y + len);
        g.addColorStop(0, 'rgba(255,232,200,0)');
        g.addColorStop(1, `rgba(255,232,200,${r2((0.1 + streak * 0.3) * m.z * 0.7)})`);
        fctx.strokeStyle = g;
        fctx.lineWidth = 0.6 + m.z;
        fctx.beginPath();
        fctx.moveTo(m.x, m.y);
        fctx.lineTo(m.x, m.y + len);
        fctx.stroke();
      } else {
        const tw = 0.5 + 0.5 * Math.sin(t * 1.3 + m.ph);
        fctx.fillStyle = `rgba(255,216,150,${r2((0.15 + tw * 0.45) * Math.min(1, m.z) * (1 - seg(p, 0.85, 0.9) * 0.6))})`;
        fctx.beginPath();
        fctx.arc(m.x, m.y, 0.6 + m.z * 1.1, 0, Math.PI * 2);
        fctx.fill();
      }
    }
    fctx.globalCompositeOperation = 'source-over';
  }

  /* ================= ввод ================= */

  let target = 0;
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  // отладка: ?p=0.5 открывает нужный момент прыжка
  const qp = new URLSearchParams(location.search).get('p');
  const debugP = qp === null ? null : clamp(parseFloat(qp) || 0, 0, 1);

  function readScroll() {
    const max = document.documentElement.scrollHeight - innerHeight;
    target = max > 0 ? clamp(scrollY / max, 0, 1) : 0;
  }

  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    mouse.tx = (e.clientX / innerWidth) * 2 - 1;
    mouse.ty = (e.clientY / innerHeight) * 2 - 1;
  });

  /* ================= кадр ================= */

  let p = 0, prevP = 0, last = performance.now();
  let landed = false, shake = 0, flash = 0;
  let wantTime = 0;

  // перемотка: новый кадр запрашиваем, только когда предыдущий уже показан
  function seekLeap(time) {
    wantTime = time;
    const v = el.leap;
    if (v.readyState < 1 || v.seeking) return;
    if (Math.abs(v.currentTime - time) > 0.5 / 30) v.currentTime = time;
  }
  el.leap.addEventListener('seeked', () => seekLeap(wantTime));

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now / 1000;

    if (debugP !== null) target = debugP;
    // плавное «догоняние» прокрутки — без рывков от колеса мыши
    p += (target - p) * (1 - Math.pow(0.004, dt));
    if (Math.abs(target - p) < 1e-5) p = target;
    if (debugP !== null) p = debugP;
    const dp = dt > 0 ? (p - prevP) / dt : 0;
    prevP = p;

    mouse.x += (mouse.tx - mouse.x) * (1 - Math.pow(0.02, dt));
    mouse.y += (mouse.ty - mouse.y) * (1 - Math.pow(0.02, dt));

    // ролик
    const dur = el.leap.duration || 10;
    seekLeap(seg(p, T.start, T.end) * (dur - 0.05));

    // цикл на карнизе растворяется в начале прыжка
    const idleO = 1 - eIO(seg(p, T.start, T.start + 0.025));
    el.idle.style.opacity = r2(idleO);
    if (idleO <= 0 && !el.idle.paused) el.idle.pause();
    if (idleO > 0 && el.idle.paused && el.idle.src) el.idle.play().catch(() => {});

    // лёгкий блюр и притемнение в «моменты» с текстом
    const beat = beatAmount(p);
    el.leap.style.filter = beat > 0.01 ? `blur(${r2(beat * 3)}px) brightness(${r2(1 - beat * 0.4)})` : 'none';

    // удар в стог
    if (!landed && p >= T.impact) {
      landed = true;
      if (!reduceMotion) { shake = 0.7; flash = 0.25; }
    } else if (landed && p < T.impact - 0.03) {
      landed = false;
    }
    shake *= Math.exp(-dt * 5);
    flash *= Math.exp(-dt * 3.5);

    // медленный наезд на главном экране + лёгкий параллакс от мыши
    const kb = reduceMotion ? 1.03 : 1.03 + 0.05 * (1 - seg(t - introStart, 0, 9)) * (1 - seg(p, 0, T.start));
    const sx = -mouse.x * 14 + (shake > 0.01 ? (Math.random() - 0.5) * 22 * shake : 0);
    const sy = -mouse.y * 9 + (shake > 0.01 ? (Math.random() - 0.5) * 22 * shake : 0);
    el.cam.style.transform = `translate3d(${r2(sx)}px,${r2(sy)}px,0) scale(${r2(kb)})`;

    const falling = seg(p, 0.12, 0.18) * (1 - seg(p, T.impact - 0.03, T.impact));
    drawFx(p, t, dt, falling * clamp(0.35 + Math.abs(dp) * 6, 0, 1));

    el.rays.style.opacity = r2((1 - seg(p, 0.02, 0.08)) * 0.6);
    el.rays.style.transform = `translate3d(${r2(W / 2 + sx)}px,${r2(H * 0.12 + sy)}px,0)`;
    el.flash.style.opacity = r2(flash);

    el.syncFill.style.height = Math.round(p * 100) + '%';
    el.hint.style.visibility = p > 0.04 ? 'hidden' : 'visible';
    if (document.body.classList.contains('ready')) el.hint.style.opacity = r2(1 - seg(p, 0.003, 0.03));
    el.legal.style.opacity = r2(seg(p, 0.95, 1));
    document.documentElement.style.setProperty('--endShade', r2(seg(p, 0.77, 0.81)));

    for (const pn of el.panels) {
      const a = +pn.dataset.in, b = +pn.dataset.out;
      const fin = a < 0 ? 1 : seg(p, a, a + 0.022);
      const fout = seg(p, b - 0.022, b);
      const o = Math.min(fin, 1 - fout);
      pn.style.opacity = r2(o);
      pn.style.visibility = o > 0 ? 'visible' : 'hidden';
      pn.firstElementChild.style.transform = `translate3d(0,${r2((1 - fin) * 40 - fout * 40)}px,0)`;
    }

    requestAnimationFrame(frame);
  }

  /* ================= старт ================= */

  let introStart = 0;
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  scrollTo(0, 0);
  resize();
  readScroll();
  addEventListener('scroll', readScroll, { passive: true });
  addEventListener('touchstart', () => {
    if (el.idle.paused && el.idle.src) el.idle.play().catch(() => {});
    if (el.leap.readyState >= 1) prime(el.leap);
  }, { once: true, passive: true });
  // подсказка: на телефоне не колёсико мыши, а «листай вниз»
  if (PHONE || matchMedia('(hover: none)').matches) {
    el.hint.classList.add('touch');
    el.hint.setAttribute('aria-label', 'Листай вниз');
    el.hint.innerHTML = '<span class="swipe"><i></i></span><span class="lbl">Листай вниз</span>';
  }
  addEventListener('resize', () => { resize(); readScroll(); });

  // после анимации появления отдаём прозрачность обратно скрипту
  document.querySelectorAll('.reveal').forEach((n) =>
    n.addEventListener('animationend', () => n.classList.remove('reveal'), { once: true }));

  loadMedia().finally(() => {
    if (!PHONE) loadLeapToMemory().catch(() => { el.loadPct.textContent = ''; });
    scrollTo(0, 0);
    readScroll();
    introStart = performance.now() / 1000;
    document.body.classList.add('ready');
    requestAnimationFrame((n) => { last = n; frame(n); });
  });
})();
