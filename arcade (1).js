/*!
 * Mzansi Arcade — a lightweight, dependency-free 2D football mini-game
 * for mobile + desktop browsers. Drop this file next to index.html and
 * call MzansiArcade.start(container, options) to mount it.
 *
 * No build step, no external assets, no network calls.
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------
  const FIELD_L = 68;   // field length (attack axis), in field units
  const FIELD_W = 44;   // field width
  const GOAL_W = 9;     // goal mouth width
  const PLAYER_R = 1.15;
  const BALL_R = 0.55;
  const SIDE_PAD = 3;   // run-off behind goal / touchline padding for camera

  const SPEED = {
    walk: 8.2,
    sprint: 12.5,
    aiChase: 9.0,
    turn: 10 // how fast facing angle catches up to velocity
  };

  const STAMINA_DRAIN = 0.09;   // per second while sprinting
  const STAMINA_REGEN = 0.05;   // per second otherwise
  const MATCH_SECONDS = 4 * 60; // arcade-length "full time"

  const COLORS = {
    pitchA: '#1e5e34',
    pitchB: '#1a5430',
    chalk: 'rgba(233,242,216,.85)',
    net: 'rgba(255,255,255,.55)',
    ball: '#f2eddd',
    ballShade: '#c9c2a8',
    shadow: 'rgba(0,0,0,.28)',
    home: { shirt: '#f2b90c', shirt2: '#c99400', shorts: '#101014', sock: '#101014', skin: '#a5673f' },
    away: { shirt: '#12908f', shirt2: '#0b6564', shorts: '#0b2b2a', sock: '#0e7c7b', skin: '#8a5a36' },
    hud: '#0b0e0a'
  };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function dist(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return Math.sqrt(dx * dx + dy * dy); }
  function angDelta(a, b) { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; }

  // ---------------------------------------------------------------------
  // Formation (5-a-side + keeper, arcade-scale squad)
  // ---------------------------------------------------------------------
  // Coordinates are "home half" slots; mirrored for the away team.
  const FORMATION = [
    { role: 'GK', x: 3, y: 0 },
    { role: 'DEF', x: 14, y: -8 },
    { role: 'DEF', x: 14, y: 8 },
    { role: 'MID', x: 26, y: -6 },
    { role: 'MID', x: 26, y: 6 },
    { role: 'FWD', x: 34, y: 0 }
  ];

  function makeSquad(team, names) {
    return FORMATION.map((slot, i) => ({
      id: team + i,
      team,
      role: slot.role,
      isGK: slot.role === 'GK',
      home: { x: slot.x, y: slot.y },
      x: 0, y: 0, vx: 0, vy: 0, facing: 0,
      num: i + 1,
      name: (names && names[i]) || slot.role + (i + 1),
      stamina: 1,
      hasBall: false,
      state: 'HOME',
      kickCooldown: 0
    }));
  }

  // ---------------------------------------------------------------------
  // Main engine
  // ---------------------------------------------------------------------
  function AttachEngine(root, opts) {
    opts = opts || {};
    const homeName = opts.homeName || 'Bright PMB';
    const awayName = opts.awayName || 'Soweto Kings';
    const homeNames = opts.homeNames || null;
    const awayNames = opts.awayNames || null;
    const onFinalWhistle = opts.onFinalWhistle || function () {};
    const onGoal = opts.onGoal || function () {};
    const matchSeconds = opts.matchSeconds || MATCH_SECONDS;

    // ---- DOM scaffold -----------------------------------------------
    root.innerHTML = '';
    root.classList.add('mz-arcade-root');
    const wrap = document.createElement('div');
    wrap.className = 'mz-wrap';
    const canvas = document.createElement('canvas');
    canvas.className = 'mz-canvas';
    const hud = document.createElement('div');
    hud.className = 'mz-hud';
    hud.innerHTML =
      '<div class="mz-top">' +
        '<div class="mz-score"><span class="mz-h">' + esc(homeName) + '</span> <b id="mz-sh">0</b>-<b id="mz-sa">0</b> <span class="mz-a">' + esc(awayName) + '</span></div>' +
        '<div class="mz-clock" id="mz-clock">04:00</div>' +
      '</div>' +
      '<div class="mz-bottom">' +
        '<div class="mz-namebar"><b id="mz-pname">—</b><div class="mz-stabar"><i id="mz-stafill"></i></div></div>' +
        '<canvas class="mz-radar" id="mz-radar" width="120" height="80"></canvas>' +
      '</div>' +
      '<div class="mz-msg" id="mz-msg"></div>' +
      '<button class="mz-pause" id="mz-pause" aria-label="Pause">II</button>';
    const controls = document.createElement('div');
    controls.className = 'mz-controls';
    controls.innerHTML =
      '<div class="mz-stick" id="mz-stick"><div class="mz-stick-base"><div class="mz-stick-nub" id="mz-nub"></div></div></div>' +
      '<div class="mz-btns">' +
        '<button class="mz-btn mz-btn-pass" id="mz-btn-pass" data-act="pass">Pass</button>' +
        '<button class="mz-btn mz-btn-shoot" id="mz-btn-shoot" data-act="shoot">Shoot</button>' +
        '<button class="mz-btn mz-btn-sprint" id="mz-btn-sprint" data-act="sprint">Sprint</button>' +
        '<button class="mz-btn mz-btn-switch" id="mz-btn-switch" data-act="switch">Switch</button>' +
      '</div>';
    wrap.appendChild(canvas);
    wrap.appendChild(hud);
    wrap.appendChild(controls);
    root.appendChild(wrap);

    function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

    const ctx = canvas.getContext('2d');

    // ---- State ---------------------------------------------------------
    const home = makeSquad('home', homeNames);
    const away = makeSquad('away', awayNames);
    const all = home.concat(away);
    const ball = { x: FIELD_L / 2, y: 0, z: 0, vx: 0, vy: 0, vz: 0, owner: null, lastTouch: null, tackleLockUntil: 0 };

    let score = { home: 0, away: 0 };
    let gameTime = 0; // advances only while running & unpaused — safe for animation/cooldowns
    let clock = matchSeconds;
    let running = false;
    let paused = false;
    let userTeam = 'home';
    let userIdx = 5; // index within `home` array of the controlled player (forward by default)
    let camera = { x: FIELD_L / 2 };
    let msgTimer = 0;

    const input = { x: 0, y: 0, sprint: false, pass: false, shoot: false, sw: false };

    function kickoff(side) {
      all.forEach(p => { p.x = p.home.x * (p.team === 'home' ? 1 : -1) + FIELD_L / 2; p.y = p.home.y; p.vx = 0; p.vy = 0; p.hasBall = false; p.state = 'HOME'; });
      // mirror away team's x so both face the centre
      away.forEach(p => { p.x = FIELD_L - (p.home.x + FIELD_L / 2 - FIELD_L / 2) + 0; });
      away.forEach(p => { p.x = FIELD_L - (p.home.x) - (FIELD_L / 2 - FIELD_L / 2); });
      // simpler explicit placement:
      home.forEach(p => { p.x = FIELD_L / 2 - p.home.x; p.y = p.home.y; });
      away.forEach(p => { p.x = FIELD_L / 2 + p.home.x; p.y = -p.home.y; });
      ball.x = FIELD_L / 2; ball.y = 0; ball.z = 0; ball.vx = 0; ball.vy = 0; ball.vz = 0; ball.owner = null; ball.noPickup = null;
      const starter = (side === 'home' ? home : away)[5];
      starter.x = FIELD_L / 2 + (side === 'home' ? -1.5 : 1.5);
      starter.y = 0;
    }

    kickoff('home');
    setMsg((opts.kickoffMsg) || 'Kick-off!', 1600);

    function setMsg(text, ms) {
      const el = hud.querySelector('#mz-msg');
      el.textContent = text;
      el.style.opacity = '1';
      msgTimer = ms || 1400;
    }

    // ---- Controls: keyboard --------------------------------------------
    const keys = {};
    function onKeyDown(e) {
      if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].indexOf(e.key) !== -1) e.preventDefault();
      keys[e.key.toLowerCase()] = true;
      if (e.key === ' ') input.shoot = true;
      if (e.key.toLowerCase() === 'x') input.pass = true;
      if (e.key.toLowerCase() === 'c') input.sw = true;
    }
    function onKeyUp(e) { keys[e.key.toLowerCase()] = false; if (e.key === ' ') input.shoot = false; if (e.key.toLowerCase() === 'x') input.pass = false; }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    function readKeyboardVector() {
      let x = 0, y = 0;
      if (keys['arrowup'] || keys['w']) y -= 1;
      if (keys['arrowdown'] || keys['s']) y += 1;
      if (keys['arrowleft'] || keys['a']) x -= 1;
      if (keys['arrowright'] || keys['d']) x += 1;
      input.sprint = !!keys['shift'];
      return { x, y };
    }

    // ---- Controls: touch joystick --------------------------------------
    const stickEl = controls.querySelector('#mz-stick');
    const nubEl = controls.querySelector('#mz-nub');
    let stickTouchId = null, stickCenter = { x: 0, y: 0 }, stickVec = { x: 0, y: 0 };
    const STICK_RADIUS = 42;

    function stickStart(id, cx, cy) {
      stickTouchId = id;
      const r = stickEl.getBoundingClientRect();
      stickCenter = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      stickMove(id, cx, cy);
    }
    function stickMove(id, cx, cy) {
      if (id !== stickTouchId) return;
      let dx = cx - stickCenter.x, dy = cy - stickCenter.y;
      const d = Math.min(STICK_RADIUS, Math.sqrt(dx * dx + dy * dy)) || 0;
      const a = Math.atan2(dy, dx);
      const nx = Math.cos(a) * d, ny = Math.sin(a) * d;
      nubEl.style.transform = 'translate(' + nx + 'px,' + ny + 'px)';
      stickVec = { x: nx / STICK_RADIUS, y: ny / STICK_RADIUS };
    }
    function stickEnd(id) {
      if (id !== stickTouchId) return;
      stickTouchId = null; stickVec = { x: 0, y: 0 };
      nubEl.style.transform = 'translate(0,0)';
    }
    stickEl.addEventListener('touchstart', e => { e.preventDefault(); const t = e.changedTouches[0]; stickStart(t.identifier, t.clientX, t.clientY); }, { passive: false });
    stickEl.addEventListener('touchmove', e => { e.preventDefault(); const t = e.changedTouches[0]; stickMove(t.identifier, t.clientX, t.clientY); }, { passive: false });
    stickEl.addEventListener('touchend', e => { const t = e.changedTouches[0]; stickEnd(t.identifier); });
    stickEl.addEventListener('touchcancel', e => { const t = e.changedTouches[0]; stickEnd(t.identifier); });
    // mouse fallback for the stick (desktop testing / mouse users)
    let mouseDown = false;
    stickEl.addEventListener('mousedown', e => { mouseDown = true; stickStart('mouse', e.clientX, e.clientY); });
    window.addEventListener('mousemove', e => { if (mouseDown) stickMove('mouse', e.clientX, e.clientY); });
    window.addEventListener('mouseup', () => { if (mouseDown) { mouseDown = false; stickEnd('mouse'); } });

    // ---- Controls: buttons (touch + mouse) ------------------------------
    function bindBtn(id, onDown, onUp) {
      const el = controls.querySelector(id);
      const down = e => { e.preventDefault(); onDown(); el.classList.add('active'); };
      const up = e => { onUp && onUp(); el.classList.remove('active'); };
      el.addEventListener('touchstart', down, { passive: false });
      el.addEventListener('touchend', up);
      el.addEventListener('mousedown', down);
      el.addEventListener('mouseup', up);
      el.addEventListener('mouseleave', up);
    }
    bindBtn('#mz-btn-pass', () => { input.pass = true; }, () => { input.pass = false; });
    bindBtn('#mz-btn-shoot', () => { input.shoot = true; }, () => { input.shoot = false; });
    bindBtn('#mz-btn-switch', () => { input.sw = true; }, () => { input.sw = false; });
    bindBtn('#mz-btn-sprint', () => { input.sprintBtn = true; }, () => { input.sprintBtn = false; });

    hud.querySelector('#mz-pause').addEventListener('click', () => { paused = !paused; });

    // ---------------------------------------------------------------
    // AI + physics helpers
    // ---------------------------------------------------------------
    function controlledPlayer() { return home[userIdx]; }

    function nearestTo(list, x, y, excludeGK) {
      let best = null, bd = Infinity;
      for (const p of list) {
        if (excludeGK && p.isGK) continue;
        const d = dist(p.x, p.y, x, y);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    }

    function attackDir(team) { return team === 'home' ? 1 : -1; } // home attacks +x, away attacks -x

    function moveToward(p, tx, ty, spd, dt) {
      const dx = tx - p.x, dy = ty - p.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 0.05) { p.vx = 0; p.vy = 0; return; }
      p.vx = (dx / d) * spd;
      p.vy = (dy / d) * spd;
    }

    function teamOf(p) { return p.team === 'home' ? home : away; }
    function oppOf(p) { return p.team === 'home' ? away : home; }

    function aiUpdate(p, dt) {
      if (p === controlledPlayer() && running) return; // user drives this one
      const opp = oppOf(p);
      const mine = teamOf(p);
      const dir = attackDir(p.team);
      const ballOwnerTeam = ball.owner ? ball.owner.team : null;
      const weHaveBall = ballOwnerTeam === p.team;
      const theyHaveBall = ballOwnerTeam && ballOwnerTeam !== p.team;

      if (p.isGK) {
        // Stay near goal line, shuffle to cover the ball's y, come out a little if ball is very close.
        const goalX = dir === 1 ? 2 : FIELD_L - 2;
        const closeToGoal = Math.abs(ball.x - goalX) < 10;
        const tx = goalX + (closeToGoal ? dir * clamp((ball.x - goalX) * dir, 0, 4) : 0);
        const ty = clamp(ball.y, -GOAL_W / 2 + 0.6, GOAL_W / 2 - 0.6);
        moveToward(p, tx, ty, SPEED.aiChase * 0.8, dt);
        // keeper claims loose ball right at the box
        if (!ball.owner && dist(p.x, p.y, ball.x, ball.y) < PLAYER_R + BALL_R + 0.3 && Math.abs(ball.x - goalX) < 12) {
          claimBall(p);
        }
        return;
      }

      if (weHaveBall && p.hasBall) {
        // Simple decision: run toward goal; shoot if close; else pass to most advanced open teammate.
        const goalX = dir === 1 ? FIELD_L : 0;
        const distToGoal = Math.abs(goalX - p.x);
        if (distToGoal < 16 && Math.abs(p.y) < GOAL_W && p.kickCooldown <= 0) {
          shootBall(p);
          return;
        }
        if (p.kickCooldown <= 0 && Math.random() < 0.01) {
          const mate = bestPassTarget(p);
          if (mate) { passBall(p, mate); return; }
        }
        moveToward(p, p.x + dir * 6, clamp(ball.y + (Math.random() - 0.5) * 2, -FIELD_W / 2 + 2, FIELD_W / 2 - 2), SPEED.aiChase, dt);
        return;
      }

      if (weHaveBall) {
        // Support run: get ahead of the ball, roughly in your lane.
        const tx = clamp(ball.x + dir * (6 + Math.random() * 6), 2, FIELD_L - 2);
        const ty = clamp(p.home.y * (p.team === 'home' ? 1 : -1) * 0.6 + ball.y * 0.3, -FIELD_W / 2 + 2, FIELD_W / 2 - 2);
        moveToward(p, tx, ty, SPEED.aiChase * 0.7, dt);
        return;
      }

      if (theyHaveBall) {
        // Nearest defender presses the ball; others mark space / track runners.
        const pressers = mine.filter(q => !q.isGK);
        const nearestMine = nearestTo(pressers, ball.x, ball.y, true);
        if (nearestMine === p) {
          moveToward(p, ball.x, ball.y, SPEED.aiChase, dt);
          if (dist(p.x, p.y, ball.x, ball.y) < PLAYER_R + BALL_R + 0.25) tackle(p);
        } else {
          const tx = clamp(p.home.x * (p.team === 'home' ? 1 : -1), 2, FIELD_L - 2);
          const ty = clamp(p.home.y * (p.team === 'home' ? 1 : -1) * 0.5 + ball.y * 0.3, -FIELD_W / 2 + 2, FIELD_W / 2 - 2);
          moveToward(p, lerp(p.x, tx, 0.5), lerp(p.y, ty, 0.5), SPEED.aiChase * 0.6, dt);
        }
        return;
      }

      // Loose ball: whoever's closest goes for it, others hold shape.
      const chasers = mine.filter(q => !q.isGK);
      const closest = nearestTo(chasers, ball.x, ball.y, true);
      if (closest === p) {
        moveToward(p, ball.x, ball.y, SPEED.aiChase, dt);
      } else {
        const tx = clamp(p.home.x * (p.team === 'home' ? 1 : -1), 2, FIELD_L - 2);
        const ty = clamp(p.home.y * (p.team === 'home' ? 1 : -1), -FIELD_W / 2 + 2, FIELD_W / 2 - 2);
        moveToward(p, lerp(p.x, tx, 0.4), lerp(p.y, ty, 0.4), SPEED.aiChase * 0.5, dt);
      }
    }

    function bestPassTarget(p) {
      const mine = teamOf(p).filter(q => q !== p && !q.isGK);
      const dir = attackDir(p.team);
      let best = null, bestScore = -Infinity;
      for (const m of mine) {
        const forwardness = (m.x - p.x) * dir;
        const d = dist(p.x, p.y, m.x, m.y);
        if (d > 22 || d < 2) continue;
        const s = forwardness - d * 0.3;
        if (s > bestScore) { bestScore = s; best = m; }
      }
      return best;
    }

    function claimBall(p) {
      all.forEach(q => q.hasBall = false);
      p.hasBall = true;
      ball.owner = p;
      ball.lastTouch = p;
    }

    function releaseBall() {
      if (ball.owner) ball.owner.hasBall = false;
      ball.owner = null;
    }

    function passBall(from, to) {
      releaseBall();
      from.kickCooldown = 0.35;
      const dx = to.x - from.x, dy = to.y - from.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const power = clamp(d * 1.15, 6, 26);
      ball.vx = (dx / d) * power;
      ball.vy = (dy / d) * power;
      ball.vz = 1.2;
      ball.z = 0.3;
      ball.noPickup = { player: from, t: 0.45 };
    }

    function shootBall(from) {
      releaseBall();
      from.kickCooldown = 0.5;
      const dir = attackDir(from.team);
      const goalX = dir === 1 ? FIELD_L : 0;
      const targetY = clamp(-from.y * 0.4 + (Math.random() - 0.5) * 3, -GOAL_W / 2 + 0.8, GOAL_W / 2 - 0.8);
      const dx = goalX - from.x, dy = targetY - from.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const power = 24 + Math.random() * 8;
      ball.vx = (dx / d) * power;
      ball.vy = (dy / d) * power;
      ball.vz = 3.4;
      ball.z = 0.35;
      ball.noPickup = { player: from, t: 0.6 };
    }

    function tackle(p) {
      if (p.kickCooldown > 0) return;
      if (gameTime < ball.tackleLockUntil) return; // only one tackle can land at a time, game-wide
      if (!ball.owner) return;
      if (ball.owner.team === p.team) return;
      const dispossessed = ball.owner;
      p.kickCooldown = 0.9;
      ball.tackleLockUntil = gameTime + 0.9;
      releaseBall();
      // Squirt the ball a short way in the tackler's direction of travel
      // (with a little randomness) rather than a pure random scatter, and
      // stop the dispossessed player from winning it straight back.
      const base = Math.hypot(p.vx, p.vy) > 0.2 ? Math.atan2(p.vy, p.vx) : p.facing;
      const a = base + (Math.random() - 0.5) * 1.2;
      ball.vx = Math.cos(a) * 5;
      ball.vy = Math.sin(a) * 5;
      ball.vz = 0.5;
      ball.noPickup = { player: dispossessed, t: 0.5 };
      setMsg('Tackle!', 700);
    }

    // ---------------------------------------------------------------
    // Physics step
    // ---------------------------------------------------------------
    function step(dt) {
      gameTime += dt;
      // -- user input --
      const kb = readKeyboardVector();
      let vx = kb.x || stickVec.x, vy = kb.y || stickVec.y;
      const mag = Math.sqrt(vx * vx + vy * vy);
      const user = controlledPlayer();
      const sprinting = (input.sprint || input.sprintBtn) && user.stamina > 0.05;
      const spd = sprinting ? SPEED.sprint : SPEED.walk;
      if (mag > 0.05) {
        user.vx = (vx / (mag > 1 ? mag : 1)) * spd;
        user.vy = (vy / (mag > 1 ? mag : 1)) * spd;
        user.facing = Math.atan2(user.vy, user.vx);
      } else {
        user.vx = 0; user.vy = 0;
      }
      user.stamina = clamp(user.stamina + (sprinting ? -STAMINA_DRAIN : STAMINA_REGEN) * dt, 0, 1);

      if (input.pass && user.hasBall && user.kickCooldown <= 0) {
        const mate = bestPassTarget(user) || nearestTo(teamOf(user).filter(q => q !== user), user.x + attackDir(user.team) * 8, user.y);
        if (mate) passBall(user, mate);
        input.pass = false;
      }
      if (input.shoot && user.hasBall && user.kickCooldown <= 0) {
        shootBall(user);
        input.shoot = false;
      }
      if (input.sw) {
        switchPlayer();
        input.sw = false;
      }
      if (!user.hasBall && ball.owner && ball.owner.team === 'away' && dist(user.x, user.y, ball.x, ball.y) < PLAYER_R + BALL_R + 0.25) {
        tackle(user);
      }

      // -- AI for everyone else --
      all.forEach(p => { if (p !== user) aiUpdate(p, dt); });
      if (user.isGK) aiUpdate(user, dt); // safety net if user ever controls a GK slot

      // -- integrate players --
      all.forEach(p => {
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.x = clamp(p.x, 0.5, FIELD_L - 0.5);
        p.y = clamp(p.y, -FIELD_W / 2 + 0.5, FIELD_W / 2 - 0.5);
        const spd = Math.hypot(p.vx, p.vy);
        if (spd > 0.2) p.facing = Math.atan2(p.vy, p.vx);
        // walk-phase only advances while actually moving, in game time —
        // freezes when paused and doesn't drift while idle.
        p.walkPhase = (p.walkPhase || 0) + spd * dt * 3;
        if (p.kickCooldown > 0) p.kickCooldown -= dt;
      });

      // -- personal space: stop players piling into the same spot, which is
      // what was turning contests into a chaotic scrum with the ball
      // ping-ponging between a crowd of players. --
      const MIN_SEP = PLAYER_R * 1.9;
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i], b = all[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > 0.001 && d < MIN_SEP) {
            const push = (MIN_SEP - d) * 0.5;
            const nx = dx / d, ny = dy / d;
            // the ball carrier holds their ground; everyone else yields
            if (a !== ball.owner) { a.x -= nx * push; a.y -= ny * push; }
            if (b !== ball.owner) { b.x += nx * push; b.y += ny * push; }
          }
        }
      }

      // -- ball --
      if (ball.owner) {
        const o = ball.owner;
        const tx = o.x + Math.cos(o.facing) * (PLAYER_R + BALL_R + 0.15);
        const ty = o.y + Math.sin(o.facing) * (PLAYER_R + BALL_R + 0.15);
        ball.x = lerp(ball.x, tx, 0.55);
        ball.y = lerp(ball.y, ty, 0.55);
        ball.z = 0;
      } else {
        ball.x += ball.vx * dt;
        ball.y += ball.vy * dt;
        ball.z = Math.max(0, ball.z + ball.vz * dt);
        if (ball.z > 0) ball.vz -= 9.8 * dt; else { ball.vz = 0; ball.z = 0; }
        const fr = ball.z > 0 ? 0.995 : 0.93;
        ball.vx *= Math.pow(fr, dt * 60);
        ball.vy *= Math.pow(fr, dt * 60);

        // touchline bounce
        if (ball.y < -FIELD_W / 2 + BALL_R) { ball.y = -FIELD_W / 2 + BALL_R; ball.vy *= -0.5; }
        if (ball.y > FIELD_W / 2 - BALL_R) { ball.y = FIELD_W / 2 - BALL_R; ball.vy *= -0.5; }

        // goal check
        if (ball.x < 0.05 && Math.abs(ball.y) < GOAL_W / 2) { scoreGoal('away'); return; }
        if (ball.x > FIELD_L - 0.05 && Math.abs(ball.y) < GOAL_W / 2) { scoreGoal('home'); return; }
        // dead-ball line bounce (arcade simplification: no throw-ins, just rebound)
        if (ball.x < 0.05 || ball.x > FIELD_L - 0.05) { ball.vx *= -0.5; ball.x = clamp(ball.x, 0.1, FIELD_L - 0.1); }

        // pick-up (a player who just kicked the ball can't instantly reclaim it)
        if (ball.noPickup) {
          ball.noPickup.t -= dt;
          if (ball.noPickup.t <= 0) ball.noPickup = null;
        }
        const carrier = nearestTo(all, ball.x, ball.y, false);
        const blocked = ball.noPickup && carrier === ball.noPickup.player;
        if (carrier && !blocked && dist(carrier.x, carrier.y, ball.x, ball.y) < PLAYER_R + BALL_R + 0.1 && Math.hypot(ball.vx, ball.vy) < 16) {
          claimBall(carrier);
          ball.noPickup = null;
        }
      }

      // -- camera --
      const camTarget = clamp(ball.x, 10, FIELD_L - 10);
      const camStep = clamp(camTarget - camera.x, -0.5, 0.5); // cap how fast the camera can pan per tick
      camera.x += camStep * 0.06;

      // -- clock --
      if (running && !paused) {
        clock -= dt;
        if (clock <= 0) { clock = 0; endMatch(); }
      }
      if (user.kickCooldown < 0) user.kickCooldown = 0;
      if (msgTimer > 0) { msgTimer -= dt * 1000; if (msgTimer <= 0) hud.querySelector('#mz-msg').style.opacity = '0'; }
    }

    function switchPlayer() {
      // pick the home outfield player closest to the ball that isn't currently controlled
      let best = -1, bd = Infinity;
      home.forEach((p, i) => {
        if (p.isGK) return;
        const d = dist(p.x, p.y, ball.x, ball.y);
        if (d < bd) { bd = d; best = i; }
      });
      if (best >= 0) userIdx = best;
    }

    function scoreGoal(side) {
      score[side]++;
      hud.querySelector('#mz-sh').textContent = score.home;
      hud.querySelector('#mz-sa').textContent = score.away;
      setMsg((side === 'home' ? homeName : awayName) + ' score!', 2200);
      onGoal(Object.assign({}, score));
      kickoff(side === 'home' ? 'away' : 'home');
    }

    function endMatch() {
      running = false;
      setMsg('Full time: ' + score.home + '-' + score.away, 5000);
      onFinalWhistle(Object.assign({}, score));
    }

    // ---------------------------------------------------------------
    // Rendering (pseudo-depth camera, pixel-art style)
    // ---------------------------------------------------------------
    let W = 0, H = 0, DPR = 1;
    function resize() {
      const r = wrap.getBoundingClientRect();
      W = Math.max(280, r.width);
      H = Math.max(180, r.height);
      DPR = Math.min(2, global.devicePixelRatio || 1);
      canvas.width = W * DPR;
      canvas.height = H * DPR;
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
    }
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    // Depth scale: things far from the camera (toward the attacking goal
    // at the top of the screen) are smaller and closer together.
    const DEPTH_RANGE = 22; // how many field-units of depth are visible
    function project(fx, fy) {
      const depth = clamp((fx - (camera.x - DEPTH_RANGE * 0.35)) / DEPTH_RANGE, 0, 1); // 0 near, 1 far
      const scale = lerp(1.35, 0.55, depth);
      const screenY = lerp(H * 0.94, H * 0.16, depth);
      const spread = lerp(1.15, 0.55, depth);
      const screenX = W / 2 + fy * (W / FIELD_W) * spread;
      return { x: screenX, y: screenY, s: scale };
    }

    function drawPitch() {
      ctx.fillStyle = COLORS.pitchB;
      ctx.fillRect(0, 0, W, H);
      // mow stripes as horizontal bands with perspective
      const bands = 14;
      for (let i = 0; i < bands; i++) {
        const fx0 = camera.x - DEPTH_RANGE * 0.35 + (i / bands) * DEPTH_RANGE * 1.6 - DEPTH_RANGE * 0.3;
        const fx1 = fx0 + (DEPTH_RANGE * 1.6) / bands;
        const a = project(fx0, -FIELD_W / 2), b = project(fx0, FIELD_W / 2);
        const c = project(fx1, FIELD_W / 2), d = project(fx1, -FIELD_W / 2);
        ctx.fillStyle = i % 2 === 0 ? COLORS.pitchA : COLORS.pitchB;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y);
        ctx.closePath(); ctx.fill();
      }
      // touchlines
      ctx.strokeStyle = COLORS.chalk; ctx.lineWidth = 2;
      [-FIELD_W / 2, FIELD_W / 2].forEach(y => {
        ctx.beginPath();
        for (let fx = camera.x - DEPTH_RANGE; fx <= camera.x + DEPTH_RANGE; fx += 2) {
          const pt = project(fx, y);
          fx === camera.x - DEPTH_RANGE ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y);
        }
        ctx.stroke();
      });
      // goal lines + boxes
      [0, FIELD_L].forEach(gx => {
        if (gx < camera.x - DEPTH_RANGE || gx > camera.x + DEPTH_RANGE) return;
        const a = project(gx, -FIELD_W / 2), b = project(gx, FIELD_W / 2);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        const boxDepth = gx === 0 ? 9 : -9;
        const c = project(gx + boxDepth, -GOAL_W / 2 - 4), d = project(gx + boxDepth, GOAL_W / 2 + 4);
        const ga = project(gx, -GOAL_W / 2 - 4), gb = project(gx, GOAL_W / 2 + 4);
        ctx.beginPath(); ctx.moveTo(ga.x, ga.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.lineTo(gb.x, gb.y); ctx.stroke();
      });
      // halfway line + centre circle
      if (FIELD_L / 2 > camera.x - DEPTH_RANGE && FIELD_L / 2 < camera.x + DEPTH_RANGE) {
        const a = project(FIELD_L / 2, -FIELD_W / 2), b = project(FIELD_L / 2, FIELD_W / 2);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }

    function drawGoal(gx, flip) {
      if (gx < camera.x - DEPTH_RANGE || gx > camera.x + DEPTH_RANGE) return;
      const postH = 3.1;
      const a = project(gx, -GOAL_W / 2), b = project(gx, GOAL_W / 2);
      const topL = { x: a.x, y: a.y - postH * a.s * 6 };
      const topR = { x: b.x, y: b.y - postH * b.s * 6 };
      ctx.strokeStyle = COLORS.net; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(topL.x, topL.y); ctx.lineTo(topR.x, topR.y); ctx.lineTo(b.x, b.y);
      ctx.stroke();
      // simple net hatching
      ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1;
      const steps = 6;
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        ctx.beginPath();
        ctx.moveTo(lerp(a.x, topL.x, t), lerp(a.y, topL.y, t));
        ctx.lineTo(lerp(b.x, topR.x, t), lerp(b.y, topR.y, t));
        ctx.stroke();
      }
    }

    function outlineRect(x, y, w, h, r) {
      ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = r;
      ctx.strokeRect(x, y, w, h);
    }

    function drawPlayer(p) {
      const pt = project(p.x, p.y);
      const s = pt.s * 1.15; // slightly larger overall for readability
      const kit = COLORS[p.team];
      const bob = Math.hypot(p.vx, p.vy) > 0.3 ? Math.sin(p.walkPhase || 0) * 1.1 * s : 0;
      const lw = Math.max(0.6, 0.5 * s);

      // shadow
      ctx.fillStyle = COLORS.shadow;
      ctx.beginPath();
      ctx.ellipse(pt.x, pt.y + 2 * s, 5.4 * s, 2 * s, 0, 0, Math.PI * 2);
      ctx.fill();

      const bodyY = pt.y - 8 * s + bob;

      // ring under the controlled player (drawn first, under the legs)
      if (p.team === 'home' && p === controlledPlayer()) {
        ctx.strokeStyle = 'rgba(255,90,60,.9)'; ctx.lineWidth = lw;
        ctx.beginPath(); ctx.ellipse(pt.x, pt.y + 1.5 * s, 5.6 * s, 2.1 * s, 0, 0, Math.PI * 2); ctx.stroke();
      }

      // legs
      ctx.fillStyle = kit.shorts;
      ctx.fillRect(pt.x - 3 * s, bodyY + 5 * s, 2.2 * s, 6 * s);
      ctx.fillRect(pt.x + 0.8 * s, bodyY + 5 * s, 2.2 * s, 6 * s);
      ctx.fillStyle = kit.sock;
      ctx.fillRect(pt.x - 3 * s, bodyY + 9 * s, 2.2 * s, 2.4 * s);
      ctx.fillRect(pt.x + 0.8 * s, bodyY + 9 * s, 2.2 * s, 2.4 * s);
      // torso (outlined so the silhouette reads against the pitch)
      ctx.fillStyle = kit.shirt;
      ctx.fillRect(pt.x - 4 * s, bodyY - 2 * s, 8 * s, 8 * s);
      ctx.fillStyle = kit.shirt2;
      ctx.fillRect(pt.x - 4 * s, bodyY - 2 * s, 8 * s, 2 * s);
      outlineRect(pt.x - 4 * s, bodyY - 2 * s, 8 * s, 8 * s, lw);
      // head, outlined
      ctx.fillStyle = kit.skin;
      ctx.beginPath(); ctx.arc(pt.x, bodyY - 4.5 * s, 3.2 * s, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = lw * 0.8;
      ctx.beginPath(); ctx.arc(pt.x, bodyY - 4.5 * s, 3.2 * s, 0, Math.PI * 2); ctx.stroke();

      if (ball.owner === p) {
        ctx.fillStyle = 'rgba(255,255,255,.18)';
        ctx.beginPath(); ctx.arc(pt.x, bodyY + 2 * s, 6.4 * s, 0, Math.PI * 2); ctx.fill();
      }
      // shirt number, only when reasonably close
      if (s > 0.85) {
        ctx.fillStyle = 'rgba(0,0,0,.6)';
        ctx.font = '700 ' + (6 * s) + 'px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(p.num), pt.x, bodyY + 4 * s);
      }
    }

    function drawBall() {
      const pt = project(ball.x, ball.y);
      const s = pt.s;
      const lift = ball.z * s * 10;
      ctx.fillStyle = COLORS.shadow;
      ctx.beginPath(); ctx.ellipse(pt.x, pt.y + 2 * s, 2.6 * s, 1.1 * s, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COLORS.ball;
      ctx.beginPath(); ctx.arc(pt.x, pt.y - lift, 2 * s, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = Math.max(0.5, 0.35 * s);
      ctx.stroke();
      ctx.fillStyle = COLORS.ballShade;
      ctx.beginPath(); ctx.arc(pt.x - 0.6 * s, pt.y - lift - 0.5 * s, 0.7 * s, 0, Math.PI * 2); ctx.fill();
    }

    function drawRadar() {
      const rc = hud.querySelector('#mz-radar');
      const rx = rc.getContext('2d');
      rx.clearRect(0, 0, 120, 80);
      rx.fillStyle = 'rgba(9,20,10,.55)';
      rx.fillRect(0, 0, 120, 80);
      rx.strokeStyle = 'rgba(233,242,216,.5)';
      rx.strokeRect(4, 4, 112, 72);
      const toRadar = (fx, fy) => ({ x: 4 + (fx / FIELD_L) * 112, y: 40 + (fy / FIELD_W) * 72 });
      all.forEach(p => {
        const pt = toRadar(p.x, p.y);
        rx.fillStyle = p.team === 'home' ? '#f2b90c' : '#12908f';
        rx.beginPath(); rx.arc(pt.x, pt.y, p === controlledPlayer() ? 3 : 2, 0, Math.PI * 2); rx.fill();
      });
      const bp = toRadar(ball.x, ball.y);
      rx.fillStyle = '#fff';
      rx.beginPath(); rx.arc(bp.x, bp.y, 1.6, 0, Math.PI * 2); rx.fill();
    }

    function render() {
      if (opts.debug) {
        global.__mzDebug = { home, away, ball, score, clock, userIdx };
      }
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.clearRect(0, 0, W, H);
      drawPitch();
      drawGoal(0);
      drawGoal(FIELD_L);
      const sorted = all.concat().sort((a, b) => a.x - b.x);
      sorted.forEach(drawPlayer);
      drawBall();
      drawRadar();

      const cp = controlledPlayer();
      hud.querySelector('#mz-pname').textContent = cp.name;
      hud.querySelector('#mz-stafill').style.width = Math.round(cp.stamina * 100) + '%';
      const mm = Math.floor(clock / 60), ss = Math.floor(clock % 60);
      hud.querySelector('#mz-clock').textContent = (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
    }

    // ---------------------------------------------------------------
    // Loop
    // ---------------------------------------------------------------
    let raf = null, last = 0, acc = 0;
    const STEP = 1 / 60;
    function loop(t) {
      raf = global.requestAnimationFrame(loop);
      if (!last) last = t;
      let dt = (t - last) / 1000;
      last = t;
      if (dt > 0.25) dt = 0.25;
      if (!paused) {
        acc += dt;
        while (acc >= STEP) { step(STEP); acc -= STEP; }
      }
      render();
    }

    function start() {
      running = true;
      raf = global.requestAnimationFrame(loop);
    }

    function destroy() {
      running = false;
      if (raf) global.cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      root.innerHTML = '';
    }

    return {
      start,
      destroy,
      pause: () => { paused = true; },
      resume: () => { paused = false; },
      getScore: () => Object.assign({}, score),
      setControlledIndex: i => { userIdx = clamp(i, 0, home.length - 1); }
    };
  }

  const MzansiArcade = {
    start(container, options) {
      const engine = AttachEngine(container, options || {});
      engine.start();
      return engine;
    }
  };

  global.MzansiArcade = MzansiArcade;
})(typeof window !== 'undefined' ? window : this);
