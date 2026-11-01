// Campus Bus Tracker: backend + simulator in one process.
// Stops are PLACEHOLDERS. Replace names/coordinates with your real campuses and pickup points.
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const DWELL = 20;      // seconds a bus waits at each stop (simulated time)
const BASE_SPEED = 6.5; // metres per second (~23 km/h)

const STOPS = {
  C25:  { name: 'Campus 25 (Hub)',                  lat: 20.364723321499188, lng: 85.81691339013645 },
  C6:   { name: 'Campus 6',                         lat: 20.35258303883895, lng: 85.81942140315306 },
  K13:  { name: 'KSAC - Campus 13',                 lat: 20.356816804320868, lng: 85.81840483891327 },
  KP10: { name: 'KP 10 (King Palace 10B) back side', lat: 20.354757314553876, lng: 85.81630428809416 },
  STAR: { name: 'Star City, Patia',                 lat: 20.361100280566124, lng: 85.82605725464369 },
};

const toXY = p => [p.lng * 111320 * Math.cos(20.35 * Math.PI / 180), p.lat * 110540];
const dist = (a, b) => { const [x1, y1] = toXY(a), [x2, y2] = toXY(b); return Math.hypot(x2 - x1, y2 - y1); };

function buildRoute(id, name, color, stopIds) {
  const pts = stopIds.map(i => STOPS[i]);
  const loop = [...pts, pts[0]];
  const cum = [0];
  for (let i = 1; i < loop.length; i++) cum.push(cum[i - 1] + dist(loop[i - 1], loop[i]));
  return { id, name, color, stopIds, loop, cum, total: cum[cum.length - 1],
           stopS: cum.slice(0, stopIds.length), factor: 1 };
}

const ROUTES = {
  R1: buildRoute('R1', 'Campus 25 - Campus 6',  '#d64045', ['C25', 'C6']),
  R2: buildRoute('R2', 'Campus 25 - KSAC (13)', '#2a6fdb', ['C25', 'K13']),
  R3: buildRoute('R3', 'Campus 25 - KP 10',     '#1f9d63', ['C25', 'KP10']),
  R4: buildRoute('R4', 'Campus 25 - Star City', '#8e4ec6', ['C25', 'STAR']),
};

const mkBus = (id, routeId, frac, active = true) => ({
  id, plate: 'OD-02-' + (1000 + Number(id.slice(1)) * 37), routeId,
  s: ROUTES[routeId].total * frac, speed: BASE_SPEED + (Math.random() - 0.5),
  dwell: 0, active, broken: false, occ: 0.3,
});
const BUSES = [
  mkBus('B1', 'R1', 0), mkBus('B2', 'R1', 0.5), mkBus('B3', 'R2', 0.1), mkBus('B4', 'R2', 0.6),
  mkBus('B5', 'R3', 0.2), mkBus('B6', 'R3', 0.7), mkBus('B7', 'R4', 0.3), mkBus('B8', 'R4', 0.8),
  mkBus('B9', 'R1', 0.25, false), mkBus('B10', 'R4', 0.55, false), // spare / extra buses
];
const EXTRAS = ['B9', 'B10'];
const FIRST_OF_ROUTE = ['B1', 'B3', 'B5', 'B7'];

// ---- Simulation state ----
let simTime = 8 * 3600, mult = 10, scenario = 'normal', announcement = '', occTarget = 0.35;

function applyScenario(name) {
  scenario = name;
  Object.values(ROUTES).forEach(r => (r.factor = 1));
  BUSES.forEach(b => { b.broken = false; b.active = !EXTRAS.includes(b.id); });
  occTarget = 0.35; announcement = '';
  if (name === 'rush') {
    BUSES.forEach(b => (b.active = true)); occTarget = 0.85;
    announcement = 'Class-hour rush: extra buses added on Campus 6 and Star City routes.';
  } else if (name === 'traffic') {
    ROUTES.R1.factor = 0.4;
    announcement = 'Heavy traffic on Route 1. Expect long delays.';
  } else if (name === 'breakdown') {
    const b = BUSES.find(x => x.id === 'B1'); b.broken = true;
    BUSES.find(x => x.id === 'B9').active = true;
    announcement = 'Bus B1 has broken down. Replacement bus B9 is on its way.';
  } else if (name === 'night') {
    BUSES.forEach(b => (b.active = FIRST_OF_ROUTE.includes(b.id))); occTarget = 0.1;
    announcement = 'Night service: one bus per route.';
  }
}

function step(b, dt) {
  const r = ROUTES[b.routeId];
  b.occ = Math.min(1, Math.max(0, b.occ + (occTarget - b.occ) * 0.02 * dt + (Math.random() - 0.5) * 0.01));
  if (!b.active || b.broken) return;
  if (b.dwell > 0) { b.dwell = Math.max(0, b.dwell - dt); return; }
  const remaining = b.speed * r.factor * dt;
  let nearest = Infinity, idx = -1;
  r.stopS.forEach((ss, i) => { const d = (ss - b.s + r.total) % r.total; if (d > 0 && d < nearest) { nearest = d; idx = i; } });
  if (nearest <= remaining) { b.s = r.stopS[idx]; b.dwell = DWELL; }
  else b.s = (b.s + remaining) % r.total;
}

function positionAt(r, s) {
  let i = 0;
  while (i < r.cum.length - 2 && s >= r.cum[i + 1]) i++;
  const t = (s - r.cum[i]) / (r.cum[i + 1] - r.cum[i] || 1);
  const a = r.loop[i], c = r.loop[i + 1];
  return { lat: a.lat + (c.lat - a.lat) * t, lng: a.lng + (c.lng - a.lng) * t };
}

function etaTo(b, r, stopIdx) {
  const d = (r.stopS[stopIdx] - b.s + r.total) % r.total;
  if (d === 0 && b.dwell > 0) return 0;
  const dd = d === 0 ? r.total : d;
  const between = r.stopS.filter(x => { const q = (x - b.s + r.total) % r.total; return q > 0 && q < dd; }).length;
  return dd / (b.speed * r.factor) + between * DWELL + b.dwell;
}

const occLabel = o => (o < 0.4 ? 'Seats available' : o < 0.75 ? 'Filling up' : 'Crowded');
const statusOf = b => (b.broken ? 'Breakdown' : ROUTES[b.routeId].factor < 1 ? 'Delayed' : b.dwell > 0 ? 'At stop' : 'Running');

function arrivalsForStop(stopId) {
  const out = [];
  BUSES.filter(b => b.active && !b.broken).forEach(b => {
    const r = ROUTES[b.routeId], i = r.stopIds.indexOf(stopId);
    if (i >= 0) out.push({ busId: b.id, routeId: r.id, route: r.name, color: r.color,
      etaSec: Math.round(etaTo(b, r, i)), occupancy: occLabel(b.occ), status: statusOf(b) });
  });
  return out.sort((a, b) => a.etaSec - b.etaSec);
}

function legInfo(r, from, to) {
  const fi = r.stopIds.indexOf(from), ti = r.stopIds.indexOf(to);
  const d = (r.stopS[ti] - r.stopS[fi] + r.total) % r.total;
  const between = r.stopS.filter(x => { const q = (x - r.stopS[fi] + r.total) % r.total; return q > 0 && q < d; }).length;
  return Math.round(d / (BASE_SPEED * r.factor) + between * DWELL);
}

function planTrip(from, to) {
  const options = [], R = Object.values(ROUTES);
  if (from === to) return options;
  R.forEach(r => { // direct buses
    if (!r.stopIds.includes(from) || !r.stopIds.includes(to)) return;
    const next = arrivalsForStop(from).find(a => a.routeId === r.id); if (!next) return;
    const ride = legInfo(r, from, to);
    options.push({ totalSec: next.etaSec + ride,
      legs: [{ route: r.name, color: r.color, busId: next.busId, waitSec: next.etaSec, rideSec: ride }] });
  });
  if (!options.length) R.forEach(r1 => R.forEach(r2 => { // one transfer
    if (r1 === r2 || !r1.stopIds.includes(from) || !r2.stopIds.includes(to)) return;
    const hub = r1.stopIds.find(x => x !== from && x !== to && r2.stopIds.includes(x)); if (!hub) return;
    const a1 = arrivalsForStop(from).find(a => a.routeId === r1.id); if (!a1) return;
    const ride1 = legInfo(r1, from, hub), arriveHub = a1.etaSec + ride1;
    const hubBuses = arrivalsForStop(hub).filter(a => a.routeId === r2.id); if (!hubBuses.length) return;
    const lap = Math.round(r2.total / (BASE_SPEED * r2.factor)) + r2.stopIds.length * DWELL;
    const cands = hubBuses.map(a => { let e = a.etaSec; while (e < arriveHub) e += lap; return { a, e }; }).sort((x, y) => x.e - y.e);
    const a2 = cands[0].a, e2 = cands[0].e;
    const ride2 = legInfo(r2, hub, to);
    options.push({ totalSec: e2 + ride2, legs: [
      { route: r1.name, color: r1.color, busId: a1.busId, waitSec: a1.etaSec, rideSec: ride1 },
      { route: r2.name, color: r2.color, busId: a2.busId, waitSec: e2 - arriveHub, rideSec: ride2, transferAt: STOPS[hub].name }] });
  }));
  return options.sort((a, b) => a.totalSec - b.totalSec);
}

function snapshot() {
  return { simTime, speed: mult, scenario, announcement,
    buses: BUSES.filter(b => b.active).map(b => ({ id: b.id, plate: b.plate, routeId: b.routeId,
      ...positionAt(ROUTES[b.routeId], b.s), status: statusOf(b), occupancy: occLabel(b.occ) })) };
}

// ---- API ----
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/static', (req, res) => {
  const routes = {};
  Object.values(ROUTES).forEach(r => (routes[r.id] = { name: r.name, color: r.color, stopIds: r.stopIds,
    path: r.loop.map(p => [p.lat, p.lng]) }));
  res.json({ stops: STOPS, routes });
});
app.get('/api/stops/:id/arrivals', (req, res) => res.json(arrivalsForStop(req.params.id)));
app.get('/api/plan', (req, res) => res.json(planTrip(req.query.from, req.query.to)));
app.post('/api/scenario', (req, res) => { applyScenario(req.body.name); res.json({ ok: true, scenario }); });
app.post('/api/speed', (req, res) => { mult = Math.min(120, Math.max(1, Number(req.body.mult) || 1)); res.json({ ok: true, mult }); });

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const TICK_MS = 500;
setInterval(() => {
  const dt = (TICK_MS / 1000) * mult;
  simTime = (simTime + dt) % 86400;
  BUSES.forEach(b => step(b, dt));
  const msg = JSON.stringify(snapshot());
  wss.clients.forEach(c => c.readyState === 1 && c.send(msg));
}, TICK_MS);

applyScenario('normal');
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Campus Bus Tracker running at http://localhost:' + PORT));