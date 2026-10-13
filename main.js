(() => {
  'use strict';

  /* =====================================================================
     НАСТРОЙКИ МЕДИА
     Сценарий «лицом к камере» (как прыжок в Odyssey): герой стоит на шпиле лицом
     к зрителю, падает назад, камера смотрит на него сверху, он влетает спиной в стог.
       idle  — цикл на главном экране (рисуется на холсте вместо картинки шпиля)
       clips — клипы, нарезанные на кадры; прокрутка «проматывает» их:
               back — со шпиля: падение назад, камера разворачивается вниз
               land — падение на спине до стога, удар и солома
       stills — картинки на случай, если клип ещё не загрузился
     ===================================================================== */
  // телефон в вертикальной ориентации видит только центр кадра — грузим лёгкие кадры 640×1080
  const PHONE = innerHeight > innerWidth;
  const MEDIA = {
    idle: PHONE ? 'video/0-idle-front-m.mp4' : 'video/0-idle-front.mp4',
    clips: {
      // кадры 1920×1080; map — неравномерная перемотка [доля прокрутки, доля клипа]
      // back: первые 1,5 с он просто стоит — пролистываем быстрее, падению отдаём больше хода
      back: { pattern: PHONE ? 'frames/back-m/{n}.webp' : 'frames/back-hd/{n}.webp', count: PHONE ? 61 : 121, pad: 3, map: [[0, 0], [0.15, 0.3], [1, 1]] },
      // land: до удара (3,1 с) — 82% хода, удар и солома — остальное
      land: { pattern: PHONE ? 'frames/land-m/{n}.webp' : 'frames/land-hd/{n}.webp', count: PHONE ? 61 : 121, pad: 3, map: [[0, 0], [0.82, 0.62], [1, 1]] },
    },
    stills: {
      // focus — где герой на картинке (доля ширины/высоты), чтобы держать его в центре
      spire: { src: 'img/4-front.webp', focus: [0.5, 0.36], sun: [0.5, 0.07] },
      fall: { src: 'img/5-backfall.webp', focus: [0.5, 0.45] },
      hay: { src: 'img/3-hay.webp', focus: [0.48, 0.52] },
    },
  };

  // ключевые моменты прокрутки (доля от 0 до 1)
  const T = {
    seqStart: 0.04,  // с этого момента начинается прыжок
    leapEnd: 0.38,   // клип back доигран — дальше клип land
    landEnd: 0.97,   // клип land доигран
    impact: 0.864,   // удар в стог: 82% участка land (см. map)
    fade: 0.022,     // длина плавного перехода между клипами
  };

  /* ================= утилиты ================= */

  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const seg = (p, a, b) => clamp((p - a) / (b - a), 0, 1);
  const lerp = (a, b, t) => a + (b - a) * t;
  const eIO = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const eOut = (t) => 1 - Math.pow(1 - t, 3);
  const r2 = (n) => Math.round(n * 100) / 100;

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const el = {
    cam: $('#cam'),
    scene: $('#scene'),
    idle: $('#idle'),
    fx: $('#fx'),
    rays: $('#rays'),
    flash: $('#flash'),
    syncFill: $('#syncFill'),
    hint: $('#hint'),
    legal: $('#legal'),
    title: $('#title'),
    panels: [...document.querySelectorAll('.panel')],
  };

  // заголовок по буквам — для анимации появления
  el.title.innerHTML = [...el.title.textContent]
    .map((ch, i) => `<span class="ch" style="--i:${i}">${ch === ' ' ? ' ' : ch}</span>`)
    .join('');

  /* ================= загрузка ================= */

  const loadImg = (src) =>
    new Promise((res) => {
      const img = new Image();
      // decode() в фоновой вкладке может не завершиться — не ждём его дольше 400 мс
      img.onload = () => {
        const decoded = img.decode ? img.decode().catch(() => {}) : Promise.resolve();
        Promise.race([decoded, new Promise((r) => setTimeout(r, 400))]).then(() => res(img));
      };
      img.onerror = () => res(null);
      img.src = src;
    });

  const imgs = {};
  const clips = {};

  // кадры клипа: первый ждём, остальные догружаем в фоне по 6 штук параллельно.
  // Порядок «от грубого к точному»: сначала каждый 16-й кадр, потом 8-й, 4-й…,
  // чтобы при быстрой прокрутке в любом месте клипа уже был близкий кадр.
  async function loadClip(name, { pattern, count, pad = 3, map = null }) {
    const c = (clips[name] = { frames: new Array(count).fill(null), count, map });
    const src = (i) => pattern.replace('{n}', String(i + 1).padStart(pad, '0'));
    c.frames[0] = await loadImg(src(0));
    const order = [];
    const seen = new Set([0]);
    for (const step of [16, 8, 4, 2, 1]) {
      for (let i = 0; i < count; i += step) if (!seen.has(i)) { seen.add(i); order.push(i); }
      if (!seen.has(count - 1)) { seen.add(count - 1); order.push(count - 1); }
    }
    let next = 0;
    const worker = async () => {
      while (next < order.length) {
        const i = order[next++];
        c.frames[i] = await loadImg(src(i));
      }
    };
    Promise.all(Array.from({ length: 6 }, worker));
  }

  // кадр клипа для доли k (0…1); если нужный ещё грузится — ближайший готовый
  function clipFrame(c, k) {
    k = clamp(k, 0, 1);
    if (c.map) {
      const m = c.map;
      let j = 1;
      while (j < m.length - 1 && k > m[j][0]) j++;
      k = lerp(m[j - 1][1], m[j][1], seg(k, m[j - 1][0], m[j][0]));
    }
    const i = Math.round(k * (c.count - 1));
    for (let d = 0; d < c.count; d++) {
      if (c.frames[i - d]) return c.frames[i - d];
      if (c.frames[i + d]) return c.frames[i + d];
    }
    return c.frames[0];
  }

  async function loadMedia() {
    const s = MEDIA.stills;
    const [spire, fall, hay] = await Promise.all([loadImg(s.spire.src), loadImg(s.fall.src), loadImg(s.hay.src)]);
    Object.assign(imgs, { spire, fall, hay });

    if (MEDIA.idle) {
      // видео рисуется на холсте вместо картинки шпиля — с тем же наездом и параллаксом
      el.idle.src = MEDIA.idle;
      el.idle.play().catch(() => {});
      await new Promise((res) => {
        if (el.idle.readyState >= 2) return res();
        el.idle.addEventListener('loadeddata', res, { once: true });
        setTimeout(res, 4000);
      });
    }

    await Promise.all(
      Object.entries(MEDIA.clips).filter(([, cfg]) => cfg).map(([name, cfg]) => loadClip(name, cfg)));
  }

  /* ================= сцена ================= */

  const sctx = el.scene.getContext('2d');
  const fctx = el.fx.getContext('2d');
  let W = 0, H = 0, dpr = 1;

  function resize() {
    dpr = Math.min(2, devicePixelRatio || 1);
    // #cam чуть больше экрана (inset -2%) — запас под параллакс от мыши
    const r = el.scene.getBoundingClientRect();
    el.scene.width = Math.round(r.width * dpr);
    el.scene.height = Math.round(r.height * dpr);
    W = innerWidth;
    H = innerHeight;
    el.fx.width = Math.round(W * dpr);
    el.fx.height = Math.round(H * dpr);
    initMotes();
  }

  const size = (m) => (m.videoWidth ? [m.videoWidth, m.videoHeight] : [m.naturalWidth, m.naturalHeight]);
  // шпиль: живое видео, если оно уже играет, иначе картинка
  const spireSrc = () => (MEDIA.idle && el.idle.readyState >= 2 ? el.idle : imgs.spire);

  // рисует картинку «cover», стараясь держать точку focus в центре экрана
  function drawImg(img, focus, scale, alpha, blur = 0, rot = 0) {
    if (!img || alpha <= 0.002) return;
    const cw = el.scene.width, ch = el.scene.height;
    // на вертикальном экране кадр и так сильно увеличен — убираем лишний зум, чтобы руки влезали
    if (ch > cw) scale = Math.max(1, scale - 0.1);
    const [iw, ih] = size(img);
    const s = Math.max(cw / iw, ch / ih) * scale;
    const dw = iw * s, dh = ih * s;
    const x = clamp(cw / 2 - focus[0] * dw, cw - dw, 0);
    const y = clamp(ch / 2 - focus[1] * dh, ch - dh, 0);
    sctx.save();
    sctx.globalAlpha = alpha;
    sctx.imageSmoothingQuality = 'high';
    if (blur > 0.3) sctx.filter = `blur(${r2(blur * dpr)}px)`;
    if (rot) {
      sctx.translate(cw / 2, ch / 2);
      sctx.rotate(rot);
      sctx.translate(-cw / 2, -ch / 2);
    }
    sctx.drawImage(img, x, y, dw, dh);
    sctx.restore();
  }

  // экранная позиция точки картинки (для лучей солнца)
  function screenPoint(img, focus, scale, pt) {
    const cw = W * 1.04, ch = H * 1.04;
    if (ch > cw) scale = Math.max(1, scale - 0.1);
    const [iw, ih] = size(img);
    const s = Math.max(cw / iw, ch / ih) * scale;
    const dw = iw * s, dh = ih * s;
    const x = clamp(cw / 2 - focus[0] * dw, cw - dw, 0);
    const y = clamp(ch / 2 - focus[1] * dh, ch - dh, 0);
    return [x + pt[0] * dw - W * 0.02, y + pt[1] * dh - H * 0.02];
  }

  let introStart = 0;

  // «моменты» полёта: пока видна панель .beat, кадр слегка размыт и притемнён
  const beats = [...document.querySelectorAll('.panel.beat')].map((n) => [+n.dataset.in, +n.dataset.out]);
  const beatAmount = (p) =>
    Math.max(0, ...beats.map(([a, b]) => Math.min(eIO(seg(p, a - 0.01, a + 0.025)), 1 - eIO(seg(p, b - 0.025, b + 0.01)))));

  function drawScene(p, t) {
    const cw = el.scene.width, ch = el.scene.height;
    sctx.clearRect(0, 0, cw, ch);
    const s = MEDIA.stills;

    // медленный «наезд» на главном экране (Ken Burns)
    const kb = reduceMotion ? 0 : 0.07 * (1 - eOut(clamp((t - introStart) / 9, 0, 1)));
    const base = 1.06;
    const spireScale = base + kb;

    const ready = (name) => (clips[name] && clips[name].frames[0] ? clips[name] : null);
    const back = ready('back'), land = ready('land');
    const fy = (a, b, k) => [0.5, lerp(a.focus[1], b.focus[1], k)];

    // лёгкий блюр в «моменты» с текстом (не сильный — кадр остаётся читаемым)
    const beat = beatAmount(p);
    // переход back → land: короткая вспышка размытия и толчок зума
    const x = seg(p, T.leapEnd - T.fade, T.leapEnd + T.fade);
    const pulse = Math.sin(x * Math.PI);
    const blur = beat * 3 + pulse * 5;
    const punch = pulse * 0.05;

    // 1. шпиль: живой цикл, плавно уходит в клип back
    const introOut = back ? eIO(seg(p, T.seqStart, T.seqStart + T.fade)) : eIO(seg(p, T.seqStart, T.leapEnd));
    if (introOut < 1) drawImg(spireSrc(), s.spire.focus, spireScale, 1);
    if (!back && introOut > 0) drawImg(imgs.fall, s.fall.focus, base, introOut, blur);

    // 2. падение назад со шпиля (клип back)
    if (back && p > T.seqStart && x < 1) {
      const k = seg(p, T.seqStart, T.leapEnd);
      drawImg(clipFrame(back, k), fy(s.spire, s.fall, eIO(k)), base + punch, introOut, blur);
    }

    // 3. падение на спине до стога (клип land) — проявляется поверх back
    if (x > 0) {
      const k = seg(p, T.leapEnd, T.landEnd);
      const settle = seg(p, T.impact, 1) * 0.02;
      const a = eIO(x);
      if (land) drawImg(clipFrame(land, k), fy(s.fall, s.hay, k), base + punch - settle, a, blur);
      else {
        drawImg(imgs.fall, s.fall.focus, base + k * 0.4, a * (1 - eIO(seg(p, 0.7, T.impact))), blur);
        drawImg(imgs.hay, s.hay.focus, base - settle, a * eIO(seg(p, 0.7, T.impact)), blur);
      }
    }

    // притемнение под текстом «моментов»
    if (beat > 0.01) {
      sctx.fillStyle = `rgba(10,6,14,${r2(beat * 0.4)})`;
      sctx.fillRect(0, 0, cw, ch);
    }

    return { spireScale };
  }

  /* ================= эффекты: пыль и линии скорости ================= */

  let motes = [];

  function initMotes() {
    const n = W < 760 ? 40 : 80;
    motes = Array.from({ length: n }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      z: 0.3 + Math.random() * 1.2,
      ph: Math.random() * Math.PI * 2,
    }));
  }

  function drawFx(p, t, dt, speed) {
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fctx.clearRect(0, 0, W, H);

    // пыль в лучах; в падении превращается в линии скорости
    const streak = clamp(speed, 0, 1);
    const dust = 1 - seg(p, 0.85, 0.9) * 0.6;
    fctx.globalCompositeOperation = 'lighter';
    fctx.lineCap = 'round';
    for (const m of motes) {
      m.x += (6 + mouse.x * 4) * m.z * dt;
      m.y += (-8 * m.z - speed * 2600 * m.z) * dt;
      if (m.y < -60) { m.y = H + 20; m.x = Math.random() * W; }
      if (m.x > W + 20) m.x = -20;
      const tw = 0.5 + 0.5 * Math.sin(t * 1.3 + m.ph);
      if (streak > 0.05) {
        if (Math.abs(m.x - W / 2) < W * 0.08) continue;
        const len = 20 + streak * 240 * m.z;
        const a = 0.1 + streak * 0.35;
        const g = fctx.createLinearGradient(0, m.y, 0, m.y + len);
        g.addColorStop(0, 'rgba(255,232,200,0)');
        g.addColorStop(1, `rgba(255,232,200,${r2(a * m.z * 0.7)})`);
        fctx.strokeStyle = g;
        fctx.lineWidth = 0.6 + m.z;
        fctx.beginPath();
        fctx.moveTo(m.x, m.y);
        fctx.lineTo(m.x, m.y + len);
        fctx.stroke();
      } else {
        fctx.fillStyle = `rgba(255,216,150,${r2((0.15 + tw * 0.45) * dust * Math.min(1, m.z))})`;
        fctx.beginPath();
        fctx.arc(m.x, m.y, 0.6 + m.z * 1.1, 0, Math.PI * 2);
        fctx.fill();
      }
    }
    fctx.globalCompositeOperation = 'source-over';
  }

  /* ================= ввод ================= */

  let target = 0;
  // отладка: ?p=0.5 открывает нужный момент прыжка
  const qp = new URLSearchParams(location.search).get('p');
  const debugP = qp === null ? null : clamp(parseFloat(qp) || 0, 0, 1);
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };

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

  let p = 0;
  let prevP = 0;
  let last = performance.now();
  let landed = false;
  let shake = 0;
  let flash = 0;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now / 1000;

    if (debugP !== null) target = debugP;
    p += (target - p) * (1 - Math.pow(0.0015, dt));
    if (debugP !== null) p = debugP;
    if (Math.abs(target - p) < 1e-5) p = target;
    const dp = dt > 0 ? (p - prevP) / dt : 0;
    prevP = p;

    // мышь: камера слегка «качает головой»
    mouse.x += (mouse.tx - mouse.x) * (1 - Math.pow(0.02, dt));
    mouse.y += (mouse.ty - mouse.y) * (1 - Math.pow(0.02, dt));

    // удар в стог
    if (!landed && p >= T.impact) {
      landed = true;
      // солома и пыль уже есть в видео — сайт добавляет только толчок и лёгкую вспышку
      if (!reduceMotion) { shake = 0.7; flash = 0.25; }
    } else if (landed && p < T.impact - 0.03) {
      landed = false;
    }
    shake *= Math.exp(-dt * 5);
    flash *= Math.exp(-dt * 3.5);

    const sx = -mouse.x * 14 + (shake > 0.01 ? (Math.random() - 0.5) * 22 * shake : 0);
    const sy = -mouse.y * 9 + (shake > 0.01 ? (Math.random() - 0.5) * 22 * shake : 0);
    el.cam.style.transform = `translate3d(${r2(sx)}px,${r2(sy)}px,0)`;

    const { spireScale } = drawScene(p, t);

    // скорость падения (для линий): только пока летим
    const falling = seg(p, 0.12, 0.18) * (1 - seg(p, T.impact - 0.03, T.impact));
    const speed = falling * clamp(0.35 + Math.abs(dp) * 6, 0, 1);
    drawFx(p, t, dt, speed);

    // лучи солнца — только пока виден шпиль и нет видео-кадров
    const raysO = 1 - seg(p, 0.1, 0.2);
    el.rays.style.opacity = r2(raysO * 0.9);
    if (raysO > 0 && imgs.spire) {
      const [rx, ry] = screenPoint(spireSrc(), MEDIA.stills.spire.focus, spireScale, MEDIA.stills.spire.sun);
      el.rays.style.transform = `translate3d(${r2(rx + sx)}px,${r2(ry + sy)}px,0)`;
    }

    el.flash.style.opacity = r2(flash);

    // HUD
    const sync = Math.round(p * 100);
    el.syncFill.style.height = sync + '%';
    el.hint.style.visibility = p > 0.04 ? 'hidden' : 'visible';
    if (document.body.classList.contains('ready')) {
      el.hint.style.opacity = r2(1 - seg(p, 0.003, 0.03));
    }
    el.legal.style.opacity = r2(seg(p, 0.95, 1));
    document.documentElement.style.setProperty('--endShade', r2(seg(p, 0.89, 0.93)));

    // текст
    for (const pn of el.panels) {
      const a = +pn.dataset.in, b = +pn.dataset.out;
      const fin = a < 0 ? 1 : seg(p, a, a + 0.022);
      const fout = seg(p, b - 0.022, b);
      const o = Math.min(fin, 1 - fout);
      pn.style.opacity = r2(o);
      pn.style.pointerEvents = o > 0.6 ? 'auto' : 'none';
      pn.style.visibility = o > 0 ? 'visible' : 'hidden';
      pn.firstElementChild.style.transform = `translate3d(0,${r2((1 - fin) * 40 - fout * 40)}px,0)`;
    }

    requestAnimationFrame(frame);
  }

  /* ================= старт ================= */

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  scrollTo(0, 0);

  resize();
  readScroll();
  addEventListener('scroll', readScroll, { passive: true });
  let rt;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { resize(); readScroll(); }, 100);
  });

  // после анимации появления отдаём прозрачность обратно скрипту
  document.querySelectorAll('.reveal').forEach((n) =>
    n.addEventListener('animationend', () => n.classList.remove('reveal'), { once: true }));

  loadMedia().then(() => {
    // сайт всегда начинается со шпиля, даже если браузер восстановил прокрутку
    scrollTo(0, 0);
    readScroll();
    introStart = performance.now() / 1000;
    document.body.classList.add('ready');
    requestAnimationFrame((n) => { last = n; frame(n); });
  });
})();
