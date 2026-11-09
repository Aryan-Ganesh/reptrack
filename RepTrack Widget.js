// Variables used by Scriptable: icon-color: lime; icon-glyph: dumbbell;
// RepTrack Widget — shows real data synced from the RepTrack web app. No network access, no fake numbers.
// Run inside Scriptable for a menu (Sync / Preview). Added to the Home Screen it renders the widget.

const CONFIG = {
  APP_URL: 'https://aryan-ganesh.github.io/reptrack/', // opened when you tap the widget
  WEEKLY_GOAL: 4,          // workouts per week for the progress bar
  WEEK_STARTS_ON: 1,       // 1 = Monday, 0 = Sunday
  STREAK_MAX_GAP_DAYS: 2,  // 2 = one rest day between workouts keeps the streak alive
  STALE_AFTER_DAYS: 7,     // footer turns orange if you haven't synced this long
  FILE: 'reptrack-widget.json'
};

// ===== RepTrack stats core (same code is embedded in the PWA export and the widget) =====
const RT = (() => {
  const DAY = 86400000;
  const sod = d => { d = new Date(d); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };      // local midnight
  const dayDiff = (a, b) => Math.round((sod(b) - sod(a)) / DAY);                                           // whole local days (DST-safe)
  const weekStart = (d, startsOn = 1) => { const s = sod(d); s.setDate(s.getDate() - ((s.getDay() - startsOn + 7) % 7)); return s; };
  const ok = w => w && !isNaN(new Date(w.date));
  function week(ws, now, startsOn = 1) {
    const s = weekStart(now, startsOn), r = { count: 0, volume: 0, sets: 0, perDay: [0,0,0,0,0,0,0], countPerDay: [0,0,0,0,0,0,0] };
    for (const w of ws) { if (!ok(w)) continue; const i = dayDiff(s, w.date); if (i < 0 || i > 6) continue;
      r.count++; r.volume += +w.volume || 0; r.sets += +w.sets || 0; r.perDay[i] += +w.volume || 0; r.countPerDay[i]++; }
    return r;
  }
  // Streak = workout days in a chain where consecutive workout days are <= maxGap days apart
  // (maxGap 2 allows one rest day) and the latest workout is <= maxGap days before today.
  function streak(ws, now, maxGap = 2) {
    const days = [...new Set(ws.filter(ok).map(w => sod(w.date).getTime()))].sort((a, b) => b - a);
    if (!days.length || dayDiff(days[0], now) > maxGap) return 0;
    let n = 1; for (let i = 1; i < days.length; i++) { if (dayDiff(days[i], days[i - 1]) <= maxGap) n++; else break; }
    return n;
  }
  // "Next workout" = the plan after the most recently logged workout's plan (rotation); first plan if unknown.
  function next(plans, ws) {
    if (!plans || !plans.length) return null;
    const last = ws.filter(ok).sort((a, b) => new Date(b.date) - new Date(a.date))[0];
    return plans[((last ? plans.indexOf(last.name) : -1) + 1) % plans.length];
  }
  const today = (ws, now) => ws.filter(w => ok(w) && dayDiff(w.date, now) === 0);
  // PR = heaviest weight for an exercise (reps > 0) beating every earlier workout's heaviest. First-ever sets are baselines, not PRs.
  function prs(ws) {
    const sorted = ws.filter(ok).sort((a, b) => new Date(a.date) - new Date(b.date)), recent = [], best = {};
    for (const w of sorted) for (const e of w.exercises || []) {
      let t = null;
      for (const s of e.sets || []) { const wt = +s.weight || 0, r = +s.reps || 0;
        if (wt > 0 && r > 0 && (!t || wt > t.weight || (wt === t.weight && r > t.reps))) t = { weight: wt, reps: r }; }
      if (!t) continue;
      const prev = best[e.name] ? best[e.name].weight : 0;
      if (prev > 0 && t.weight > prev) recent.push({ exercise: e.name, weight: t.weight, reps: t.reps, date: w.date });
      if (t.weight > prev) best[e.name] = { exercise: e.name, weight: t.weight, reps: t.reps, date: w.date };
    }
    return { recent: recent.reverse(), best: Object.values(best).sort((a, b) => b.weight - a.weight) };
  }
  return { sod, dayDiff, weekStart, week, streak, next, today, prs };
})();
// ===== end core =====


const C = { bg1: new Color('#1b2030'), bg2: new Color('#0d0f14'), tile: new Color('#1f2430'), track: new Color('#303544'),
  green: new Color('#b4f26c'), text: new Color('#f5f5f8'), muted: new Color('#a5a9b7'), warn: new Color('#ffb454') };

// ---------- storage + validation ----------
const fm = FileManager.local();
const filePath = () => fm.joinPath(fm.documentsDirectory(), CONFIG.FILE);

function normalize(raw) {                                  // throws Error('reason') if unusable
  let o; try { o = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { throw new Error('Not valid JSON'); }
  if (!o || typeof o !== 'object' || o.app !== 'reptrack-widget') throw new Error('Not RepTrack widget data');
  if (o.version !== 1) throw new Error('Unsupported data version ' + o.version);
  if (!Array.isArray(o.workouts)) throw new Error('Missing workouts list');
  const gen = new Date(o.generatedAt); if (isNaN(gen)) throw new Error('Missing timestamp');
  const str = v => (typeof v === 'string' ? v : '');
  const num = v => (isFinite(+v) && +v >= 0 ? +v : 0);
  const prList = a => (Array.isArray(a) ? a : []).filter(p => p && str(p.exercise) && num(p.weight) > 0 && !isNaN(new Date(p.date)))
    .map(p => ({ exercise: p.exercise, weight: num(p.weight), reps: num(p.reps), date: p.date }));
  return {
    unit: o.unit === 'kg' ? 'kg' : 'lb', generatedAt: gen,
    plans: (Array.isArray(o.plans) ? o.plans : []).filter(p => typeof p === 'string' && p.trim()),
    workouts: o.workouts.filter(w => w && !isNaN(new Date(w.date))).map(w => ({ date: w.date, name: str(w.name) || 'Workout', volume: num(w.volume), sets: num(w.sets) })),
    prs: { recent: prList(o.prs && o.prs.recent), best: prList(o.prs && o.prs.best) }
  };
}
function load() {
  const p = filePath();
  if (!fm.fileExists(p)) return { status: 'nosync' };
  try { return { status: 'ok', data: normalize(fm.readString(p)) }; }
  catch (e) { return { status: 'corrupt', message: e.message }; }
}

// ---------- stats (recomputed at render time so a new week/day is always correct) ----------
function stats(d, now) {
  const wk = RT.week(d.workouts, now, CONFIG.WEEK_STARTS_ON), todays = RT.today(d.workouts, now);
  return { wk, streak: RT.streak(d.workouts, now, CONFIG.STREAK_MAX_GAP_DAYS), next: RT.next(d.plans, d.workouts),
    doneToday: todays.length ? todays[todays.length - 1].name : null, total: d.workouts.length };
}
const fmtVol = v => (v >= 10000 ? (v / 1000).toFixed(0) + 'k' : v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v)));
function ago(date, now) {
  const m = Math.max(0, Math.round((now - date) / 60000));
  if (m < 2) return 'just now'; if (m < 60) return m + ' min ago'; if (m < 1440) return Math.floor(m / 60) + ' h ago';
  return Math.floor(m / 1440) + ' d ago';
}
const shortDate = s => new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// ---------- UI helpers ----------
function base() {
  const w = new ListWidget(), g = new LinearGradient(); g.colors = [C.bg1, C.bg2]; g.locations = [0, 1];
  w.backgroundGradient = g; w.url = CONFIG.APP_URL; w.setPadding(12, 14, 10, 14);
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);   // iOS decides the real refresh time; this is a hint
  return w;
}
function text(parent, s, size, weight, color) {
  const t = parent.addText(String(s)); const f = { bold: Font.boldSystemFont, heavy: Font.heavySystemFont, med: Font.mediumSystemFont, reg: Font.systemFont }[weight || 'reg'];
  t.font = f(size); t.textColor = color || C.text; t.lineLimit = 1; t.minimumScaleFactor = 0.6; return t;
}
function header(w, right, compact) {
  const r = w.addStack(); r.centerAlignContent();
  let sf = null; try { sf = SFSymbol.named('dumbbell.fill'); } catch (e) {}
  if (sf) { const i = r.addImage(sf.image); i.imageSize = new Size(15, 15); i.tintColor = C.green; } else text(r, '💪', 13);
  r.addSpacer(5); text(r, 'RepTrack', 14, 'heavy');
  if (!compact) { r.addSpacer(); if (right) text(r, right.text, 10, 'reg', right.color || C.muted); }
}
function tile(parent, value, label, accent) {
  const t = parent.addStack(); t.layoutVertically(); t.backgroundColor = C.tile; t.cornerRadius = 12; t.setPadding(8, 10, 8, 10);
  text(t, value, 22, 'heavy', accent || C.green); t.addSpacer(1); text(t, label, 10, 'reg', C.muted); return t;
}
function row3(w, s, unit) {
  const r = w.addStack(); r.spacing = 8;
  tile(r, s.wk.count + '/' + CONFIG.WEEKLY_GOAL, 'THIS WEEK'); tile(r, '🔥 ' + s.streak, 'STREAK');
  tile(r, fmtVol(s.wk.volume), 'VOLUME (' + unit + ')');
}
function nextBar(w, s) {
  const b = w.addStack(); b.centerAlignContent(); b.backgroundColor = C.tile; b.cornerRadius = 10; b.setPadding(6, 10, 6, 10);
  text(b, s.doneToday ? '✓ Done today' : 'Next up', 11, 'reg', C.muted); b.addSpacer();
  text(b, s.doneToday ? s.doneToday : (s.next || 'No plans'), 13, 'bold', C.green);
}
function footer(w, d, now) {
  const stale = (now - d.generatedAt) / 86400000 > CONFIG.STALE_AFTER_DAYS;
  const f = w.addStack(); f.addSpacer(); text(f, (stale ? '⚠︎ Synced ' : 'Synced ') + ago(d.generatedAt, now), 9, 'reg', stale ? C.warn : C.muted);
}
function message(title, body, size) {
  const w = base(); header(w, null, size === 'small'); w.addSpacer();
  text(w, title, size === 'small' ? 14 : 16, 'bold').lineLimit = 2;
  w.addSpacer(4); const t = text(w, body, size === 'small' ? 10 : 12, 'reg', C.muted); t.lineLimit = 5; w.addSpacer(); return w;
}
function weekChart(wk, W, H) {
  const dc = new DrawContext(); dc.size = new Size(W, H); dc.opaque = false; dc.respectScreenScale = true;
  const max = Math.max(...wk.perDay, 1), bw = W / 7, labels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  dc.setFont(Font.systemFont(10)); dc.setTextAlignedCenter();
  for (let i = 0; i < 7; i++) {
    const has = wk.countPerDay[i] > 0, bh = has ? Math.max(5, (wk.perDay[i] / max) * (H - 18)) : 3;
    const p = new Path(); p.addRoundedRect(new Rect(i * bw + 7, H - 15 - bh, bw - 14, bh), 3, 3);
    dc.addPath(p); dc.setFillColor(has ? C.green : C.track); dc.fillPath();
    dc.setTextColor(C.muted); dc.drawTextInRect(labels[(CONFIG.WEEK_STARTS_ON + i) % 7], new Rect(i * bw, H - 13, bw, 13));
  }
  return dc.getImage();
}
function goalBar(w, done, goal, width) {
  const o = w.addStack(); o.size = new Size(width, 7); o.cornerRadius = 3.5; o.backgroundColor = C.track;
  const pct = Math.min(1, goal > 0 ? done / goal : 0);
  if (pct > 0) { const i = o.addStack(); i.size = new Size(Math.max(7, width * pct), 7); i.cornerRadius = 3.5; i.backgroundColor = C.green; }
  o.addSpacer();
}

// ---------- widget builders ----------
function small(d, s, now) {
  const w = base(); header(w, null, true); w.addSpacer();
  text(w, "TODAY'S WORKOUT", 9, 'reg', C.muted);
  text(w, s.doneToday ? '✓ ' + s.doneToday : (s.next || 'Rest day'), 20, 'heavy', C.green).lineLimit = 2;
  text(w, s.doneToday ? 'Logged today' : (s.next ? 'Up next' : 'No plans set'), 11, 'reg', C.muted);
  w.addSpacer(); const r = w.addStack(); r.centerAlignContent();
  text(r, '🔥 ' + s.streak, 15, 'bold'); r.addSpacer(); text(r, 'Tap to open', 9, 'reg', C.muted); return w;
}
function medium(d, s, now) {
  const w = base(); header(w, { text: 'Week of ' + shortDate(RT.weekStart(now, CONFIG.WEEK_STARTS_ON)) });
  w.addSpacer(8); row3(w, s, d.unit); w.addSpacer(7); nextBar(w, s); w.addSpacer(); footer(w, d, now); return w;
}
function large(d, s, now) {
  const w = base(); header(w, { text: 'Week of ' + shortDate(RT.weekStart(now, CONFIG.WEEK_STARTS_ON)) });
  w.addSpacer(8); row3(w, s, d.unit); w.addSpacer(10);
  text(w, 'WEEKLY PROGRESS · ' + s.wk.count + ' of ' + CONFIG.WEEKLY_GOAL + ' workouts', 10, 'med', C.muted); w.addSpacer(5);
  goalBar(w, s.wk.count, CONFIG.WEEKLY_GOAL, 262); w.addSpacer(8);
  const img = w.addImage(weekChart(s.wk, 262, 74)); img.imageSize = new Size(262, 74); w.addSpacer(10);
  const hasPR = d.prs.recent.length > 0, list = (hasPR ? d.prs.recent : d.prs.best).slice(0, 3);
  text(w, hasPR ? 'RECENT PERSONAL RECORDS' : 'TOP LIFTS (no new records yet)', 10, 'med', C.muted); w.addSpacer(4);
  if (!list.length) text(w, 'Log weighted sets to see records here.', 12, 'reg', C.muted);
  for (const p of list) { const r = w.addStack(); r.centerAlignContent(); text(r, p.exercise, 13, 'med'); r.addSpacer();
    text(r, p.weight + ' ' + d.unit + (p.reps ? ' × ' + p.reps : ''), 13, 'bold', C.green); r.addSpacer(8); text(r, shortDate(p.date), 10, 'reg', C.muted); w.addSpacer(3); }
  w.addSpacer(); nextBar(w, s); w.addSpacer(4); footer(w, d, now); return w;
}

function buildWidget(size, now = new Date()) {
  size = size === 'extraLarge' ? 'large' : (['small', 'medium', 'large'].includes(size) ? size : 'medium');
  try {
    const r = load();
    if (r.status === 'nosync') return message('Not synced yet', 'Open Scriptable, run “RepTrack Widget”, choose “Sync from clipboard”.', size);
    if (r.status === 'corrupt') return message('Saved data unreadable', r.message + '. Sync again from RepTrack.', size);
    const d = r.data; if (!d.workouts.length) return message('No workouts yet', 'Log a workout in RepTrack, then sync.', size);
    const s = stats(d, now); return { small, medium, large }[size](d, s, now);
  } catch (e) { return message('Widget error', String(e && e.message || e), size); }
}

// ---------- sync (manual, user-initiated) ----------
async function say(title, msg) { const a = new Alert(); a.title = title; a.message = msg; a.addAction('OK'); await a.present(); }
function saveRaw(raw) {                                         // validate BEFORE overwriting so bad data never replaces good data
  const d = normalize(raw); fm.writeString(filePath(), typeof raw === 'string' ? raw : JSON.stringify(raw));
  return 'Synced ' + d.workouts.length + ' workouts.\nData generated ' + d.generatedAt.toLocaleString() + '.';
}
async function syncClipboard() {
  const raw = Pasteboard.paste();
  if (!raw) return say('Clipboard is empty', 'In RepTrack, open Settings and tap “Copy widget data”, then try again.');
  try { await say('Sync complete', saveRaw(raw)); } catch (e) { await say('Could not sync', e.message + '.\nYour previous widget data was kept.\nIn RepTrack tap “Copy widget data” and try again.'); }
}
async function syncFile() {
  try { await say('Sync complete', saveRaw(fm.readString(await DocumentPicker.openFile()))); }
  catch (e) { await say('Could not sync', e.message + '.\nYour previous widget data was kept.'); }
}
async function status() {
  const r = load();
  await say('Data status', r.status === 'ok' ? r.data.workouts.length + ' workouts, ' + r.data.plans.length + ' plans.\nSynced ' + ago(r.data.generatedAt, new Date()) + '.'
    : r.status === 'nosync' ? 'Nothing synced yet.' : 'Saved data is unreadable: ' + r.message);
}
async function menu() {
  const a = new Alert(); a.title = 'RepTrack Widget'; ['Sync from clipboard', 'Sync from saved file', 'Preview small', 'Preview medium', 'Preview large', 'Data status']
    .forEach(x => a.addAction(x)); a.addCancelAction('Close');
  const i = await a.presentSheet();
  if (i === 0) await syncClipboard(); else if (i === 1) await syncFile(); else if (i === 2) await buildWidget('small').presentSmall();
  else if (i === 3) await buildWidget('medium').presentMedium(); else if (i === 4) await buildWidget('large').presentLarge(); else if (i === 5) await status();
}

if (config.runsInWidget) Script.setWidget(buildWidget(config.widgetFamily)); else await menu();
Script.complete();
