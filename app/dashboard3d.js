/* CredTrack — immersive 3D dashboard (particle cloud that morphs as you scroll).
   Depends on globals from app.js (state, helpers) and vendor/three.min.js (optional: the page still works without WebGL). */

let d3Cleanup = null;

function unmountDashboard3D() {
  if (d3Cleanup) { try { d3Cleanup(); } catch (e) { /* ignore */ } d3Cleanup = null; }
  document.body.classList.remove('d3-on');
}

/* ---------- page markup (real data) ---------- */
function renderDashboard() {
  const S = dashboardStats();
  const apps = state.applications;
  const last = apps[0];
  const hasScore = !!last && last.score != null;
  const first = (state.user?.full_name || '').split(' ')[0] || 'there';
  const th = thresholds();
  const over = S.budget > 0 && S.total > S.budget;
  const pace = S.budget > 0
    ? (S.projected <= S.budget
        ? `At this pace you finish at ${fmtMoney(S.projected)}, inside your ${fmtMoney(S.budget)} budget.`
        : `At this pace you finish at ${fmtMoney(S.projected)}, ${fmtMoney(S.projected - S.budget)} over your ${fmtMoney(S.budget)} budget.`)
    : `At this pace you finish the month at ${fmtMoney(S.projected)}. Set a monthly budget in Profile to compare.`;
  const headline = S.budget > 0
    ? (over ? `You are ${fmtMoney(S.total - S.budget)} over this month's budget.` : `${S.pct}% of your budget is used, and ${fmtMoney(S.budget - S.total)} is left this month.`)
    : 'A live picture of your money and your credit, with a reason for every number.';

  /* score section */
  let scoreLead;
  if (!last) scoreLead = 'You have not run a credit check yet. It takes a minute and shows exactly what to change.';
  else if (last.decision === 'approved') scoreLead = `Approved. Estimated risk of missed payments is ${(last.risk * 100).toFixed(1)}%, under the ${Math.round(th.approve_below * 100)}% line.`;
  else if (last.decision === 'borderline') scoreLead = `Borderline. Estimated risk is ${(last.risk * 100).toFixed(1)}%, between ${Math.round(th.approve_below * 100)}% and ${Math.round(th.reject_above * 100)}%. Small changes can tip it.`;
  else if (last.rule_triggered) scoreLead = `Not approved. The loan or instalment is too large for the income, so a safety limit applies and the score is capped at 650. A smaller request can change this.`;
  else scoreLead = `Not approved this time. Estimated risk is ${(last.risk * 100).toFixed(1)}%, above the ${Math.round(th.reject_above * 100)}% line. The credit check shows what to change.`;

  const cr = state.creditResult;
  const factorItems = cr ? [
    ...(cr.top_protective_factors || []).slice(0, 2).map(f => [f.factor, f.effect, 'up']),
    ...(cr.top_risk_factors || []).slice(0, 2).map(f => [f.factor, f.effect, 'dn']),
  ] : [];
  const scoreList = factorItems.length
    ? `<ul class="d3-list" aria-label="What moved your latest score">${factorItems.map(([n, e, c]) =>
        `<li><span>${escapeHtml(n)}</span><b class="d3-${c}">${e > 0 ? '+' : e < 0 ? '−' : ''}${Math.abs(e)}</b></li>`).join('')}</ul>`
    : (apps.length
        ? `<ul class="d3-list" aria-label="Recent credit checks">${apps.slice(0, 4).map(a =>
            `<li><span>${decisionLabel(a.decision)} · ${fmtDateTime(a.created_at)}</span><b class="${a.decision === 'approved' ? 'd3-up' : 'd3-dn'}">${a.score != null ? a.score : '—'}</b></li>`).join('')}</ul>`
        : '');

  /* spending section */
  const catList = S.catList.length
    ? `<ul class="d3-list" aria-label="Spending by category">${S.catList.slice(0, 4).map(([c, v]) =>
        `<li><span>${escapeHtml(c)}</span><b>${Math.round(v / S.total * 100)}% · ${fmtMoney(v)}</b></li>`).join('')}</ul>`
    : `<p class="d3-lead">No spending logged this month yet. Log an expense and your categories appear here.</p>`;

  /* journey section */
  const approved = apps.filter(a => a.decision === 'approved').length;
  const scored = apps.filter(a => a.score != null);
  const best = scored.length ? Math.max(...scored.map(a => a.score)) : null;
  const journeyTitle = apps.length ? `${plural(apps.length, 'check', 'checks')}.<br>One direction.` : 'One check<br>starts it.';
  const journeyLead = apps.length
    ? `${approved} approved${best != null ? `, best score ${best}` : ''}. Every rejection comes with a reason and a fix you can apply in one tap.`
    : 'Your credit journey starts with one check. Each result is saved here with its reasons.';
  const journeyList = apps.length
    ? `<ul class="d3-list" aria-label="Credit check history">${apps.slice(0, 4).map(a =>
        `<li><span>${decisionLabel(a.decision)}${a.round === 2 ? ' (final)' : ''}${a.rule_triggered ? ' · limit rule' : ''}</span><b class="${a.decision === 'approved' ? 'd3-up' : 'd3-dn'}">${a.score != null ? a.score : '—'}</b></li>`).join('')}</ul>`
    : '';

  const dateLine = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const streak = state.streak.current_streak || 0;

  return `
  <div class="d3-root">
    <canvas id="d3-stage" aria-hidden="true"></canvas>
    <div class="d3-vig"></div>

    <header class="d3-head">
      <a href="#dashboard" class="d3-logo"><i></i>CredTrack</a>
      <nav class="d3-story" aria-label="Dashboard sections">
        <button data-d3go="0" aria-current="true">Overview</button>
        <button data-d3go="1">Score</button>
        <button data-d3go="2">Spending</button>
        <button data-d3go="3">Journey</button>
      </nav>
      <nav class="d3-pages" aria-label="Pages">
        <span class="d3-streak" title="Daily streak">${streak} ${streak === 1 ? 'day' : 'days'}</span>
        <a href="#expenses">Expenses</a>
        <a href="#credit">Credit check</a>
        <a href="#profile">Profile</a>
        <button id="d3-logout" type="button">Log out</button>
      </nav>
    </header>

    <div class="d3-dots" aria-hidden="true">
      <button data-d3go="0" aria-current="true" tabindex="-1"></button><button data-d3go="1" tabindex="-1"></button>
      <button data-d3go="2" tabindex="-1"></button><button data-d3go="3" tabindex="-1"></button>
    </div>

    <main class="d3-main">
      <section class="d3-sec" id="d3-s0">
        <div class="d3-tag">${greeting()} · ${dateLine}</div>
        <h1>Welcome back,<br>${escapeHtml(first)}.</h1>
        <p class="d3-lead">${headline} Move your cursor through the cloud.</p>
        <div class="d3-btns">
          <a class="d3-btn" href="#credit">Check my credit score</a>
          <a class="d3-btn d3-ghost" href="#expenses">Log an expense</a>
        </div>
      </section>

      <section class="d3-sec" id="d3-s1">
        <div class="d3-row">
          <div class="d3-col">
            <div class="d3-tag">Latest credit score</div>
            <div class="d3-big">${hasScore ? `<span data-count="${last.score}">${last.score}</span><small>/900</small>` : '<span class="d3-none">No score yet</span>'}</div>
            <p class="d3-lead">${scoreLead}</p>
            ${!last ? '<a class="d3-btn" href="#credit">Run my first check</a>' : ''}
          </div>
          <div class="d3-col d3-right">${scoreList}</div>
        </div>
      </section>

      <section class="d3-sec" id="d3-s2">
        <div class="d3-col d3-right d3-wide">
          <div class="d3-tag">Spent this month</div>
          <div class="d3-big"><span data-count="${S.total.toFixed(2)}" data-prefix="$" data-decimals="0">${'$' + Math.round(S.total).toLocaleString('en-US')}</span></div>
          <p class="d3-lead">${plural(S.monthly.length, 'expense', 'expenses')} so far. ${pace}</p>
          ${catList}
        </div>
      </section>

      <section class="d3-sec" id="d3-s3">
        <div class="d3-col">
          <div class="d3-tag">Credit journey</div>
          <h2>${journeyTitle}</h2>
          <p class="d3-lead">${journeyLead}</p>
          ${journeyList}
          <div class="d3-btns"><a class="d3-btn" href="#credit">${apps.length ? 'Run a new check' : 'Run a credit check'}</a></div>
        </div>
      </section>
    </main>

    <footer class="d3-foot">
      <div class="d3-logo"><i></i>CredTrack</div>
      <p>Scores are estimates from a model trained on Home Credit data. No gender, age, education or bureau score is used. Not financial advice.</p>
    </footer>
    <div class="d3-hint" id="d3-hint">Scroll</div>
  </div>`;
}

/* ---------- 3D scene ---------- */
function mountDashboard3D() {
  document.body.classList.add('d3-on');
  $('#d3-logout')?.addEventListener('click', logout);

  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sections = $$('.d3-main .d3-sec');
  const goBtns = $$('[data-d3go]');
  const hint = $('#d3-hint');
  let fT = 0, f = 0, centers = [], W = innerWidth, H = innerHeight;

  const measure = () => { centers = sections.map(s => s.offsetTop + s.offsetHeight / 2); };
  const sectionPos = () => {
    const y = scrollY + H / 2, n = centers.length;
    if (!n || y <= centers[0]) return 0;
    if (y >= centers[n - 1]) return n - 1;
    for (let i = 0; i < n - 1; i++) if (y < centers[i + 1]) return i + (y - centers[i]) / (centers[i + 1] - centers[i]);
    return n - 1;
  };
  const updateUi = () => {
    const idx = Math.round(fT);
    goBtns.forEach(b => b.setAttribute('aria-current', Number(b.dataset.d3go) === idx ? 'true' : 'false'));
    if (hint) hint.style.opacity = scrollY > 60 ? 0 : 1;
  };
  const onGo = e => {
    const s = sections[Number(e.currentTarget.dataset.d3go)];
    if (s) scrollTo({ top: s.offsetTop, behavior: reduce ? 'auto' : 'smooth' });
  };
  goBtns.forEach(b => b.addEventListener('click', onGo));
  const onScroll = () => { fT = sectionPos(); updateUi(); };
  const listeners = [['scroll', onScroll, { passive: true }]];

  /* numbers count up once */
  if (!reduce) {
    $$('.d3-main [data-count]').forEach(el => {
      const end = Number(el.dataset.count), dec = Number(el.dataset.decimals || 0), pre = el.dataset.prefix || '';
      if (!isFinite(end)) return;
      const t0 = performance.now(), fmt = v => pre + v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
      const tick = now => { const p = Math.min(1, (now - t0) / 1100), e = 1 - Math.pow(1 - p, 3); el.textContent = fmt(end * e); if (p < 1) el._raf = requestAnimationFrame(tick); else el.textContent = fmt(end); };
      el._raf = requestAnimationFrame(tick);
    });
  }

  measure();
  listeners.push(['resize', () => { W = innerWidth; H = innerHeight; measure(); fT = sectionPos(); }]);
  listeners.forEach(([n, fn, o]) => window.addEventListener(n, fn, o));
  fT = sectionPos(); f = fT; updateUi();

  let rafId = 0, renderer = null, geo = null, mat = null, ro = null;
  const baseCleanup = () => {
    cancelAnimationFrame(rafId);
    listeners.forEach(([n, fn, o]) => window.removeEventListener(n, fn, o));
    goBtns.forEach(b => b.removeEventListener('click', onGo));
    $$('.d3-main [data-count]').forEach(el => cancelAnimationFrame(el._raf));
    if (ro) ro.disconnect();
    if (geo) geo.dispose();
    if (mat) { if (mat.map) mat.map.dispose(); mat.dispose(); }
    if (renderer) renderer.dispose();
  };
  d3Cleanup = baseCleanup;

  const canvas = $('#d3-stage');
  if (!window.THREE || !canvas) { document.body.classList.add('d3-nofx'); return; }
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); }
  catch (e) { document.body.classList.add('d3-nofx'); return; }
  document.body.classList.remove('d3-nofx');

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 60);
  const mobile = () => W < 761;
  const N = mobile() ? 3800 : 7000;

  /* ---- target shapes (real data drives the gauge fill and the skyline) ---- */
  const last = state.applications[0];
  const frac = last && last.score != null ? Math.max(0.03, Math.min(1, (last.score - 300) / 600)) : 0.35;
  const dayBars = (() => {
    const v = dashboardStats().fortnight.map(d => d.amount), mx = Math.max(...v, 0);
    return mx > 0 ? v.map(x => 0.12 + 0.88 * x / mx) : [.5, .8, .4, .9, .6, 1, .55, .7, .35, .85, .65, .45, .95, .6];
  })();

  const mk = fill => { const a = new Float32Array(N * 3); fill(a); return a; };
  const sphere = mk(a => { const g = Math.PI * (3 - Math.sqrt(5)); for (let i = 0; i < N; i++) { const y = 1 - 2 * (i + .5) / N, r = Math.sqrt(1 - y * y), t = g * i; a[i * 3] = Math.cos(t) * r * 2.3; a[i * 3 + 1] = y * 2.3; a[i * 3 + 2] = Math.sin(t) * r * 2.3; } });
  const gaugeFill = new Float32Array(N); // 1 = inside the score, 0 = remaining track
  const gauge = mk(a => { for (let i = 0; i < N; i++) {
    const u = i / N, v = Math.random() * Math.PI * 2, ang = Math.PI * 1.25 - u * Math.PI * 1.5, R = 2.5, r = .14 + .1 * Math.random(), rr = R + Math.cos(v) * r;
    a[i * 3] = Math.cos(ang) * rr; a[i * 3 + 1] = Math.sin(ang) * rr; a[i * 3 + 2] = Math.sin(v) * r * 1.2; gaugeFill[i] = u <= frac ? 0 : 1; } });
  const nb = dayBars.length;
  const sky = mk(a => { for (let i = 0; i < N; i++) { const b = i % nb, x = (b / (nb - 1) - .5) * 7.4, h = dayBars[b] * 4.2;
    a[i * 3] = x + (Math.random() - .5) * .3; a[i * 3 + 1] = -2.1 + Math.random() * h; a[i * 3 + 2] = (Math.random() - .5) * .8; } });
  const helix = mk(a => { for (let i = 0; i < N; i++) { const u = i / N, t = u * Math.PI * 6 + (i % 2 ? 0 : Math.PI);
    a[i * 3] = Math.cos(t) * 1.5 + (Math.random() - .5) * .25; a[i * 3 + 1] = (u - .5) * 7.2 + (Math.random() - .5) * .25; a[i * 3 + 2] = Math.sin(t) * 1.5 + (Math.random() - .5) * .25; } });
  const shapes = [sphere, gauge, sky, helix];
  const POSE = [[0, 0, 1], [.40, 0, 1], [-.44, 0, 1], [.5, 0, .95]];

  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { pos[i * 3] = (Math.random() - .5) * 20; pos[i * 3 + 1] = (Math.random() - .5) * 12; pos[i * 3 + 2] = (Math.random() - .5) * 10; }
  geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g2 = c.getContext('2d'), rg = g2.createRadialGradient(32, 32, 0, 32, 32, 32);
  rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(.4, 'rgba(255,255,255,.6)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
  g2.fillStyle = rg; g2.fillRect(0, 0, 64, 64);
  mat = new THREE.PointsMaterial({ size: .065, map: new THREE.CanvasTexture(c), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
  const pts = new THREE.Points(geo, mat); scene.add(pts);

  const resize = () => { W = innerWidth; H = innerHeight; renderer.setSize(W, H, false); camera.aspect = W / H; camera.position.set(0, 0, mobile() ? 13 : 10); camera.updateProjectionMatrix(); measure(); };
  resize();
  window.addEventListener('resize', resize); listeners.push(['resize', resize]);
  if (window.ResizeObserver) { ro = new ResizeObserver(() => { measure(); fT = sectionPos(); }); ro.observe(document.body); }

  let tmx = 0, tmy = 0, mx = 0, my = 0, mActive = false;
  const onMove = e => { tmx = e.clientX / W * 2 - 1; tmy = -(e.clientY / H * 2 - 1); mActive = true; };
  const onLeave = () => { mActive = false; };
  window.addEventListener('pointermove', onMove); window.addEventListener('pointerleave', onLeave);
  listeners.push(['pointermove', onMove], ['pointerleave', onLeave]);

  const cm = new THREE.Color(0x5cf2b0), ca = new THREE.Color(0xffb547), cc = new THREE.Color();
  const ease = t => t * t * (3 - 2 * t), lerp = (a, b, t) => a + (b - a) * t;
  const clock = new THREE.Clock(), plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const ray = new THREE.Ray(), v3 = new THREE.Vector3(), mw = new THREE.Vector3(), inv = new THREE.Matrix4();

  const frame = () => {
    const t = clock.getElapsedTime();
    f += (fT - f) * .07; mx += (tmx - mx) * .05; my += (tmy - my) * .05;
    const i0 = Math.min(Math.floor(f), 3), i1 = Math.min(i0 + 1, 3), u = ease(Math.max(0, Math.min(1, f - i0)));
    const A = shapes[i0], B = shapes[i1], mob = mobile();
    const halfW = Math.tan(camera.fov * Math.PI / 360) * camera.position.z * camera.aspect;
    const ps = lerp(POSE[i0][2], POSE[i1][2], u) * (mob ? .55 : 1);
    pts.position.set(lerp(POSE[i0][0], POSE[i1][0], u) * halfW * (mob ? .5 : 1), mob ? 2.2 : 0, 0);
    pts.scale.setScalar(ps);
    pts.rotation.y = (reduce ? 0 : Math.sin(t * .35) * .45) + mx * .45; pts.rotation.x = -my * .2;
    pts.updateMatrixWorld(true);
    let hasM = false;
    if (mActive && !reduce) {
      inv.copy(pts.matrixWorld).invert();
      ray.origin.copy(camera.position); v3.set(tmx, tmy, .5).unproject(camera).sub(camera.position).normalize(); ray.direction.copy(v3);
      if (ray.intersectPlane(plane, mw)) { mw.applyMatrix4(inv); hasM = true; }
    }
    const rad = 1.1 / ps, rad2 = rad * rad, k = .07, wob = reduce ? 0 : 1;
    const gA = i0 === 1 ? 1 - u : (i1 === 1 ? u : 0); // how much of the gauge is showing (dims the unused track)
    for (let i = 0; i < N; i++) {
      const j = i * 3;
      const tx = lerp(A[j], B[j], u) + Math.sin(t * .8 + i * .37) * .02 * wob, ty = lerp(A[j + 1], B[j + 1], u) + Math.cos(t * .7 + i * .21) * .02 * wob, tz = lerp(A[j + 2], B[j + 2], u);
      let x = pos[j], y = pos[j + 1], z = pos[j + 2];
      if (hasM) { const dx = x - mw.x, dy = y - mw.y, dz = z - mw.z, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < rad2) { const d = Math.sqrt(d2) + .001, fo = (1 - d / rad) * .5; x += dx / d * fo; y += dy / d * fo; z += dz / d * fo; } }
      x += (tx - x) * k; y += (ty - y) * k; z += (tz - z) * k;
      pos[j] = x; pos[j + 1] = y; pos[j + 2] = z;
      const m = Math.max(0, Math.min(1, (y + 2.6) / 5.2));
      cc.copy(cm).lerp(ca, m * m);
      const br = (.55 + .45 * Math.max(0, Math.min(1, (z + 3) / 6))) * (1 - gA * gaugeFill[i] * .72);
      col[j] = cc.r * br; col[j + 1] = cc.g * br; col[j + 2] = cc.b * br;
    }
    geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(frame);
  };
  rafId = requestAnimationFrame(frame);
}
