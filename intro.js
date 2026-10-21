/* =====================================================================
   BLOOP — погружение (intro.js)
   Подключать в index.html ПЕРЕД renderer.js.
   API:  BloopIntro.play({ registered, onArrived })   — запуск при старте
         BloopIntro.dive(level)                      — ныряем глубже (2, 3)
   ===================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const DESCENT_MS = 9000; // должно совпадать с --descent в intro.css

  // уровни глубины: метры, затемнение, лучи света
  const LEVELS = {
    1: { m: 120,  dark: 0.08, ray: 0.85 },
    2: { m: 480,  dark: 0.30, ray: 0.35 },
    3: { m: 1200, dark: 0.50, ray: 0.12 }
  };

  const ICEBERG_SVG = `<svg id="iceberg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1500" preserveAspectRatio="xMidYMin meet">
<defs>
  <linearGradient id="ibWater" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#7fd0ea" stop-opacity=".85"/>
    <stop offset=".25" stop-color="#3f93b8" stop-opacity=".8"/>
    <stop offset=".6" stop-color="#1b5273" stop-opacity=".75"/>
    <stop offset="1" stop-color="#0a2234" stop-opacity="0"/>
  </linearGradient>
  <linearGradient id="ibShade" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#fff" stop-opacity=".16"/>
    <stop offset="1" stop-color="#05121c" stop-opacity=".35"/>
  </linearGradient>
</defs>
<g id="ib-under">
  <polygon fill="url(#ibWater)" points="250,430 205,520 240,600 170,700 230,800 190,900 260,1010 330,1120 420,1240 520,1330 610,1390 700,1340 790,1250 880,1160 950,1050 1010,930 960,820 1030,700 980,590 1040,510 990,430"/>
  <polygon fill="#bfeaf7" opacity=".16" points="250,430 205,520 300,560 420,470 400,430"/>
  <polygon fill="#bfeaf7" opacity=".12" points="205,520 240,600 170,700 300,640 300,560"/>
  <polygon fill="#04121d" opacity=".16" points="300,560 300,640 170,700 230,800 360,760 380,640"/>
  <polygon fill="#d8f6ff" opacity=".12" points="420,470 300,560 380,640 520,600 560,500"/>
  <polygon fill="#04121d" opacity=".14" points="230,800 190,900 260,1010 400,930 360,760"/>
  <polygon fill="#d8f6ff" opacity=".10" points="360,760 400,930 520,880 560,740 380,640"/>
  <polygon fill="#04121d" opacity=".18" points="260,1010 330,1120 420,1240 520,1180 520,1040 400,930"/>
  <polygon fill="#d8f6ff" opacity=".08" points="520,880 520,1040 640,1000 680,860 560,740"/>
  <polygon fill="#04121d" opacity=".2" points="420,1240 520,1330 610,1390 640,1200 520,1180"/>
  <polygon fill="#d8f6ff" opacity=".10" points="560,500 520,600 560,740 680,700 700,560 640,470"/>
  <polygon fill="#04121d" opacity=".22" points="700,560 680,700 680,860 800,820 860,640 790,520"/>
  <polygon fill="#04121d" opacity=".26" points="860,640 800,820 880,900 1010,930 960,820 1030,700 980,590"/>
  <polygon fill="#d8f6ff" opacity=".09" points="790,520 860,640 980,590 1040,510 990,430 900,430"/>
  <polygon fill="#04121d" opacity=".3" points="680,860 640,1000 640,1200 700,1340 790,1250 880,1160 950,1050 880,900 800,820"/>
  <polygon fill="#d8f6ff" opacity=".07" points="640,1000 520,1040 520,1180 640,1200"/>
  <g fill="none" stroke="#e6fbff" stroke-linecap="round">
    <path opacity=".30" stroke-width="2" d="M300 560 L420 470 L560 500 L700 560 L790 520 L900 430"/>
    <path opacity=".20" stroke-width="2" d="M170 700 L300 640 L380 640 L520 600 L560 740 L680 700 L860 640 L980 590"/>
    <path opacity=".16" stroke-width="1.5" d="M230 800 L360 760 L400 930 L520 880 L680 860 L800 820 L1010 930"/>
    <path opacity=".12" stroke-width="1.5" d="M260 1010 L400 930 M520 1040 L640 1000 L880 900 M420 1240 L520 1180 L640 1200 L790 1250"/>
  </g>
  <polygon fill="url(#ibShade)" points="250,430 205,520 240,600 170,700 230,800 190,900 260,1010 330,1120 420,1240 520,1330 610,1390 700,1340 790,1250 880,1160 950,1050 1010,930 960,820 1030,700 980,590 1040,510 990,430" opacity=".6"/>
</g>
<g id="ib-top">
  <polygon fill="#b9d6e8" points="250,430 300,360 350,372 430,262 480,282 540,170 610,70 660,150 700,128 760,230 820,246 880,340 940,352 990,430"/>
  <polygon fill="#cfe6f4" points="250,430 300,360 350,372 430,262 400,430"/>
  <polygon fill="#e9f6fd" points="430,262 480,282 540,170 530,300 460,430 400,430"/>
  <polygon fill="#d5eaf6" points="460,430 530,300 600,250 650,300 700,330 740,430"/>
  <polygon fill="#fbfeff" points="540,170 610,70 600,250 530,300"/>
  <polygon fill="#c4def0" points="610,70 660,150 650,300 600,250"/>
  <polygon fill="#a9c8de" points="660,150 700,128 760,230 700,330 650,300"/>
  <polygon fill="#8fb2cb" points="760,230 820,246 880,340 850,430 740,430 700,330"/>
  <polygon fill="#7a9fba" points="880,340 940,352 990,430 850,430"/>
  <polygon fill="#a3c3d8" points="700,330 740,430 650,430 600,250 650,300"/>
  <polygon fill="#ffffff" opacity=".55" points="610,70 596,130 576,150 600,150 620,110"/>
  <polygon fill="#ffffff" opacity=".35" points="430,262 400,330 380,372 420,350 450,300"/>
  <polygon fill="#2a4d68" opacity=".22" points="650,300 700,330 740,430 700,430 670,360"/>
  <polygon fill="#2a4d68" opacity=".18" points="820,246 880,340 850,430 830,340"/>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path stroke="#fff" stroke-width="2.5" opacity=".8" d="M250 430 L300 360 L350 372 L430 262 L480 282 L540 170 L610 70 L660 150 L700 128"/>
    <path stroke="#2e5470" stroke-width="2" opacity=".5" d="M700 128 L760 230 L820 246 L880 340 L940 352 L990 430"/>
    <path stroke="#fff" stroke-width="1.5" opacity=".45" d="M540 170 L530 300 L600 250 L610 70 M600 250 L650 300 L660 150 M430 262 L400 430 M530 300 L460 430"/>
    <path stroke="#47708c" stroke-width="1.5" opacity=".4" d="M650 300 L700 330 L760 230 M700 330 L740 430 M880 340 L850 430"/>
  </g>
</g>
<g id="ice-fissures" fill="none" stroke-linecap="round" stroke-linejoin="round">
  <path d="M348 375 L372 394 L365 416 L395 431 L408 452" stroke="#f2fcff" stroke-opacity=".58" stroke-width="3"/>
  <path d="M372 394 L347 409 L339 430" stroke="#9bc6df" stroke-opacity=".72" stroke-width="2"/>
  <path d="M790 300 L770 326 L784 348 L760 372 L770 398" stroke="#e7f8ff" stroke-opacity=".45" stroke-width="3"/>
  <path d="M770 326 L744 333 L730 356" stroke="#6b93af" stroke-opacity=".7" stroke-width="2"/>
  <path d="M482 318 L500 332 L492 353 L512 371" stroke="#fff" stroke-opacity=".52" stroke-width="2"/>
  <path d="M890 365 L870 381 L879 401" stroke="#d6effb" stroke-opacity=".5" stroke-width="2"/>
  <path d="M530 405 Q590 389 643 411 T740 405" stroke="#effbff" stroke-opacity=".18" stroke-width="5"/>
</g>
<g id="bloop-ice-mark" transform="translate(735 365)" opacity=".92">
  <circle r="48" fill="#0a2b40" fill-opacity=".28" stroke="#e7fbff" stroke-opacity=".72" stroke-width="3"/>
  <circle r="39" fill="none" stroke="#a8eaff" stroke-opacity=".44" stroke-width="1.5"/>
  <path d="M-26 13 Q0 29 26 13" fill="none" stroke="#c8f4ff" stroke-width="3" stroke-linecap="round" opacity=".9"/>
  <path d="M-19 22 Q0 34 19 22" fill="none" stroke="#76d7f4" stroke-width="2" stroke-linecap="round" opacity=".75"/>
  <g fill="#e9fbff" stroke="#e9fbff" stroke-linejoin="round">
    <ellipse cx="0" cy="-3" rx="13" ry="10"/>
    <ellipse cx="-16" cy="-19" rx="6" ry="8" transform="rotate(-24 -16 -19)"/>
    <ellipse cx="0" cy="-25" rx="6" ry="8"/>
    <ellipse cx="16" cy="-19" rx="6" ry="8" transform="rotate(24 16 -19)"/>
    <path d="M-7 -5 Q0 -13 7 -5 L0 3Z" fill="#7acde7" stroke="none"/>
  </g>
  <path d="M-32 -33 L-43 -44 M32 -33 L43 -44" stroke="#e8fbff" stroke-opacity=".55" stroke-width="2" stroke-linecap="round"/>
</g>
<g id="ice-detail-lines" fill="none" stroke-linecap="round" stroke-linejoin="round">
  <path d="M278 402 L316 382 L337 390 L360 374 M444 285 L468 300 L455 328 L476 346" stroke="#f7fdff" stroke-opacity=".72" stroke-width="2.2"/>
  <path d="M557 190 L577 214 L565 240 L590 259 L578 284" stroke="#fff" stroke-opacity=".64" stroke-width="2"/>
  <path d="M620 95 L635 135 L620 164 L642 190 L635 224" stroke="#f5fcff" stroke-opacity=".56" stroke-width="2"/>
  <path d="M727 174 L747 208 L733 232 L756 258" stroke="#eafaff" stroke-opacity=".55" stroke-width="2"/>
  <path d="M844 281 L860 309 L844 331 L864 354" stroke="#d9f4ff" stroke-opacity=".55" stroke-width="2"/>
  <path d="M315 585 L350 571 L365 594 L395 603 M248 741 L285 719 L310 738" stroke="#e9faff" stroke-opacity=".3" stroke-width="2"/>
  <path d="M432 690 L452 719 L440 750 L468 778 M537 918 L560 948 L548 976" stroke="#d9f5ff" stroke-opacity=".24" stroke-width="2"/>
  <path d="M751 690 L778 714 L765 743 L792 762 M880 990 L904 1018 L890 1045" stroke="#d9f5ff" stroke-opacity=".24" stroke-width="2"/>
  <path d="M330 1110 L365 1132 L385 1166 M710 1190 L738 1213 L750 1240" stroke="#d9f5ff" stroke-opacity=".18" stroke-width="2"/>
</g>
<g id="ice-crystal-facets" opacity=".55">
  <polygon points="540,170 565,203 530,300 510,268" fill="#f5fcff" fill-opacity=".22"/>
  <polygon points="610,70 633,131 600,250 588,173" fill="#fff" fill-opacity=".17"/>
  <polygon points="760,230 790,275 850,430 805,390" fill="#163d58" fill-opacity=".22"/>
  <polygon points="350,372 400,430 370,449 325,413" fill="#fff" fill-opacity=".13"/>
  <polygon points="520,880 560,910 520,1040 495,985" fill="#dff8ff" fill-opacity=".12"/>
  <polygon points="800,820 840,845 880,900 838,886" fill="#04121d" fill-opacity=".16"/>
</g>
</svg>`;

  /* ------------------------------ DOM ------------------------------ */
  function build() {
    document.body.insertAdjacentHTML('afterbegin', `
      <div id="world"><div id="world-track">
        <div id="sky"><div class="aurora"></div><div class="aurora a2"></div></div>
        <div id="sea"></div>
        <div id="iceberg-wrap">${ICEBERG_SVG}</div>
        <div id="waves"></div><div id="waves2"></div>
      </div></div>
      <div id="water-bridge" aria-hidden="true"></div>
      <div id="seal-easter-egg" aria-hidden="true">
        <svg viewBox="0 0 220 130" role="presentation">
          <defs><linearGradient id="sealSkin" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b6d8e3"/><stop offset=".55" stop-color="#6b9bad"/><stop offset="1" stop-color="#315c70"/></linearGradient></defs>
          <path d="M38 77 Q48 48 88 43 Q120 33 150 50 Q174 62 185 78 Q167 88 145 86 Q122 104 94 96 L69 106 Q56 109 58 97 L70 86 Q49 88 38 77Z" fill="url(#sealSkin)" stroke="#c8edf5" stroke-opacity=".65" stroke-width="2"/>
          <path d="M82 89 Q65 109 47 103 Q57 89 70 81 M128 91 Q151 111 169 101 Q155 87 144 81" fill="#557f91" stroke="#b6dce7" stroke-opacity=".5" stroke-width="2"/>
          <ellipse cx="159" cy="61" rx="18" ry="15" fill="#8eb8c7"/>
          <circle cx="165" cy="57" r="2.7" fill="#061b2a"/><path d="M174 65 l8 3 -8 3" fill="#16394b"/>
          <path d="M178 69 l18 -3 M178 72 l18 4 M177 66 l15 -9" fill="none" stroke="#d4f1f6" stroke-opacity=".75" stroke-width="1.2"/>
          <g fill="#e5fbff" opacity=".75"><circle cx="28" cy="46" r="3"/><circle cx="20" cy="32" r="1.8"/><circle cx="194" cy="39" r="2.4"/></g>
        </svg>
      </div>
      <div id="depth-dark"></div>
      <div id="rays"></div>
      <canvas id="fx"></canvas>
      <div id="depth-meter"><span class="dm-label">[ ГЛУБИНА ]</span><span class="dm-value" id="dm-value">0 м</span></div>
      <div id="intro-black"></div>
      <div id="intro-logo"><img src="logo.png" alt="" onerror="this.style.display='none'"><h1>BLOOP</h1></div>
    `);

    // переливающееся море за сообщениями
    const chat = document.querySelector('.chat-container');
    if (chat) chat.insertAdjacentHTML('afterbegin', '<div class="chat-sea"><i></i><i></i></div>');
  }

  /* ---------------------------- раскладка --------------------------- */
  let W = 0, H = 0, wlPx = 340;
  function layout() {
    W = window.innerWidth; H = window.innerHeight;
    const scale = Math.min(W / 1200, (H * 1.5) / 1500); // как SVG вписывается в блок 100% x 150vh
    wlPx = 430 * scale;                                  // y линии воды в viewBox = 430
    document.documentElement.style.setProperty('--wl', wlPx + 'px');
    const cv = $('fx');
    if (cv) { cv.width = W; cv.height = H; }
  }

  /* --------------------- частицы: снег, пузыри, муть -------------------- */
  let ctx = null, snow = [], bubbles = [], motes = [];
  let snowA = 1, snowTarget = 1, deepA = 0, deepTarget = 0;
  let speed = 1, speedTarget = 1, lastT = 0, fxRunning = false, fxRaf = 0;

  const rnd = (a, b) => a + Math.random() * (b - a);

  function initParticles() {
    snow = Array.from({ length: 70 }, () => ({ x: rnd(0, W), y: rnd(0, wlPx), vy: rnd(18, 45), ph: rnd(0, 6.28), r: rnd(0.8, 2.2), a: rnd(0.5, 0.9) }));
    motes = Array.from({ length: 80 }, () => ({ x: rnd(0, W), y: rnd(0, H), vy: rnd(8, 24), ph: rnd(0, 6.28), r: rnd(0.6, 1.8), a: rnd(0.15, 0.4) }));
    bubbles = Array.from({ length: 16 }, () => ({ x: rnd(0, W), y: rnd(0, H), vy: rnd(25, 70), ph: rnd(0, 6.28), r: rnd(2, 7) }));
  }

  function frame(now) {
    if (!fxRunning) return;
    if (document.hidden) { lastT = now; fxRaf = requestAnimationFrame(frame); return; }
    const dt = Math.min(0.05, (now - (lastT || now)) / 1000);
    lastT = now;
    snowA += (snowTarget - snowA) * Math.min(1, dt * 0.9);
    deepA += (deepTarget - deepA) * Math.min(1, dt * 0.6);
    speed += (speedTarget - speed) * Math.min(1, dt * 1.1);
    ctx.clearRect(0, 0, W, H);
    if (snowA > 0.01) {
      ctx.fillStyle = '#fff';
      for (const p of snow) {
        p.y += p.vy * dt;
        p.x += Math.sin(now / 1500 + p.ph) * 12 * dt;
        if (p.y > wlPx) { p.y = -4; p.x = rnd(0, W); }
        ctx.globalAlpha = p.a * snowA;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
      }
    }
    if (deepA > 0.01) {
      ctx.fillStyle = '#cfe8f5';
      for (const p of motes) {
        p.y -= p.vy * dt * speed;
        p.x += Math.sin(now / 2200 + p.ph) * 8 * dt;
        if (p.y < -4) { p.y = H + 4; p.x = rnd(0, W); }
        ctx.globalAlpha = p.a * deepA;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
      }
      for (const b of bubbles) {
        b.y -= b.vy * dt * speed;
        b.x += Math.sin(now / 900 + b.ph) * 22 * dt;
        if (b.y < -10) { b.y = H + 10; b.x = rnd(0, W); }
        ctx.globalAlpha = deepA;
        ctx.strokeStyle = 'rgba(190,235,255,.35)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 6.283); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,.4)';
        ctx.beginPath(); ctx.arc(b.x - b.r * 0.35, b.y - b.r * 0.35, b.r * 0.22, 0, 6.283); ctx.fill();
        ctx.fillStyle = '#cfe8f5';
      }
    }
    ctx.globalAlpha = 1;
    if (snowA > 0.015 || deepA > 0.015 || snowTarget > 0.015 || deepTarget > 0.015) {
      fxRaf = requestAnimationFrame(frame);
    } else {
      fxRunning = false;
      ctx.clearRect(0, 0, W, H);
    }
  }

  function startFx() {
    const cv = $('fx');
    ctx = cv.getContext('2d');
    initParticles();
    fxRunning = true;
    cancelAnimationFrame(fxRaf);
    fxRaf = requestAnimationFrame(frame);
  }

  /* ------------------------- шкала глубины ------------------------- */
  let dmVal = 0, dmRaf = 0, dmHideT = 0;
  function tweenDepth(to, ms) {
    cancelAnimationFrame(dmRaf);
    const from = dmVal, t0 = performance.now(), el = $('dm-value');
    (function step(now) {
      const k = Math.min(1, (now - t0) / ms);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      dmVal = from + (to - from) * e;
      el.textContent = Math.round(dmVal) + ' м';
      if (k < 1) dmRaf = requestAnimationFrame(step);
    })(t0);
  }
  function showMeter(holdMs) {
    const m = $('depth-meter');
    m.classList.add('show');
    clearTimeout(dmHideT);
    dmHideT = setTimeout(() => m.classList.remove('show'), holdMs);
  }

  function applyLevel(level, ms) {
    const L = LEVELS[level];
    if (!L) return;
    document.documentElement.style.setProperty('--t', ms + 'ms');
    $('depth-dark').style.opacity = L.dark;
    $('rays').style.opacity = L.ray;
    tweenDepth(L.m, ms);
    document.body.dataset.depth = level;
  }

  /* ------------------------------ API ------------------------------ */
  async function play(opts) {
    opts = opts || {};
    const black = $('intro-black'), logo = $('intro-logo');

    layout();
    startFx();
    window.addEventListener('resize', layout);

    // 1) чёрный экран 2.5 c
    await sleep(2500);

    // 2) логотип очень плавно проявляется (2 c), держится, плавно уходит
    logo.style.transition = 'opacity 2s ease-in-out';
    logo.style.opacity = '1';
    await sleep(2400);
    logo.style.transition = 'opacity 1.6s ease-in-out';
    logo.style.opacity = '0';
    await sleep(1800);

    // 3) из темноты проявляется градиент и айсберг, 2 c он стоит на месте
    black.style.transition = 'opacity 2.5s ease-in-out';
    black.style.opacity = '0';
    await sleep(2500 + 2000);
    black.remove(); logo.remove();

    // 4) Сначала камера проходит весь айсберг. Интерфейс всё это время
    // остаётся ниже экрана и не появляется у кромки льда.
    document.body.classList.add('descending', 'iceberg-leaving');
    snowTarget = 0; deepTarget = 1; speedTarget = 2.2;
    const icebergTravelMs = Math.max(DESCENT_MS, 7600);
    applyLevel(opts.registered ? 3 : 1, icebergTravelMs);
    showMeter(icebergTravelMs + 5000);
    await sleep(icebergTravelMs);

    // Айсберг полностью ушёл. На короткий миг остаётся только единая толща воды.
    document.body.classList.add('iceberg-gone');
    await sleep(420);

    // 5) Только теперь интерфейс плавно поднимается из глубины в ту же воду.
    document.body.classList.add('chat-rising');
    await sleep(4800);

    // 6) Прибыли
    speedTarget = 1;
    snowTarget = 0; deepTarget = 0;
    document.body.classList.add('arrived');
    if (typeof opts.onArrived === 'function') opts.onArrived();
  }

  // следующий этап — ещё глубже
  function dive(level) {
    if (!LEVELS[level]) return;
    speed = 4.5; speedTarget = 1;
    applyLevel(level, 2800);
    showMeter(3800);
  }

  build();
  window.BloopIntro = { play, dive };
})();