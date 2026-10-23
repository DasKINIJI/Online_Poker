// Start: npm install ws && node server.js  ->  http://localhost:3000
// Alle Beträge intern in Cent (ganzzahlig, 5er-Schritte). Hole Cards verlassen den Server nur an ihren Besitzer
// (oder bei Showdown / 7-2-Aufdeckung an alle).
const http = require('http'), fs = require('fs'), cr = require('crypto'), zlib = require('zlib'), { WebSocketServer } = require('ws');
const srv = http.createServer((q, r) => {
  const cm = q.url.match(/^\/cards\/([24]color|full|gold)\/([2-9TJQKA])([SHDC])\.svg$/); // nur diese 208 Karten, kein Pfad-Trick möglich
  if (cm) return fs.readFile(`${__dirname}/cards/${{ full: '4color', gold: '2color' }[cm[1]] || cm[1]}/${cm[2]}${cm[3]}.svg`, 'utf8', (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' }); r.end(deckSvg(cm[1], cm[3], d)); });
  const sm = q.url.match(/^\/sounds\/(flip|fold|check|chips|raise|allin|pot|tick)\.mp3$/);
  if (sm) return fs.readFile(`${__dirname}/sounds/${sm[1]}.mp3`, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'max-age=86400' }); r.end(d); });
  const am = q.url.match(/^\/av\/(\d+)\.jpg(\?v=\d+)?$/), a = am && L.av[am[1]]; // Profilbild pro Hauptname, Version im Link -> darf lange gecacht werden
  if (am) { if (!a) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=31536000, immutable' }); return r.end(Buffer.from(a.d, 'base64')); }
  const mm = q.url.match(/^\/md\/(\d+)\/(av|w|k[0-4])(\?v=\d+)?$/), mx = mm && (L.md[mm[1]] || {})[mm[2]]; // GIF-Profilbild, Sieges-Musik, Kill-Sounds
  if (mm) return mx ? fs.readFile(`${MDIR}/${mm[1]}-${mm[2]}`, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': mx.m, 'cache-control': 'max-age=31536000, immutable' }); r.end(d); }) : (r.writeHead(404), r.end());
  const pw = PWA[q.url.split('?')[0]]; if (pw) { r.writeHead(200, { 'content-type': pw[0], 'cache-control': pw[2] || 'max-age=86400' }); return r.end(pw[1]); } // PWA: Manifest, Service Worker, Icons
  r.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); r.end(fs.readFileSync(__dirname + '/index.html')); });
// Vorderseite 3 (vollfarbig) und 4 (Gold) aus den Vektor-Vorlagen ableiten: nur Kartengrund + Index/Pips umfärben, Bildkarten-Porträts bleiben
const FB = { S: '#2b2b30', H: '#c8202c', D: '#1f5fc4', C: '#1f8a3b' };
const deckSvg = (d, s, x) => d == 'full' ? x.replace(/<symbol id="[SV][SHDC][2-9TJQKA]"[^]*?<\/symbol>/g, m => m.replace(/(fill|stroke)="(?!none)[^"]*"/g, '$1="white"')).replace('fill="white" stroke="black"', `fill="${FB[s]}" stroke="#0006"`)
  : d == 'gold' ? x.replace('<symbol', '<defs><linearGradient id="gd" x2="1" y2="1"><stop offset="0" stop-color="#f7e6ad"/><stop offset=".5" stop-color="#d9b25a"/><stop offset="1" stop-color="#a97c2b"/></linearGradient></defs><symbol').replace('fill="white" stroke="black"', 'fill="url(#gd)" stroke="#7a5a1c"') : x;
const wss = new WebSocketServer({ server: srv });
// Dauerhaftes Konto-Ledger: uid -> Hauptname (Spielerliste beim Buy-in), alle Transaktionen. Kaputte Datei -> Abbruch statt Überschreiben.
const LF = __dirname + '/data/ledger.json';
const L = fs.existsSync(LF) ? JSON.parse(fs.readFileSync(LF, 'utf8')) : { un: 0, nm: {}, pid: {}, tx: [] };
L.ss = L.ss || []; L.av = L.av || {}; L.dn = L.dn || {}; L.md = L.md || {}; // L.dn: uid -> Name gelöschter Hauptnamen (Historie/P&L bleiben lesbar) // L.av: uid -> { d: JPEG base64, v: Version } // L.md: uid -> { Slot: { v, m: MIME } }, Dateien in data/md
delete L.du; delete L.tk; // Reste des entfernten Discord-Logins (Konten-Verknüpfung + Login-Tokens) – beim nächsten Speichern weg
const MDIR = __dirname + '/data/md'; fs.mkdirSync(MDIR, { recursive: true });
const HOOK = process.env.DISCORD_WEBHOOK; // P/L-Export einer Session in einen Discord-Channel
async function hook(x) { // P/L einer Session in den Discord-Channel (Dashboard) posten
  const P = {}, e = v => (v > 0 ? '+' : '') + (v / 100).toFixed(2).replace('.', ',') + ' €';
  x.tx.forEach(t => { const p = P[t.uid] ??= { i: 0, o: 0, n: nm(t.uid) }; if (/^(Buy|Rebuy)/.test(t.type)) p.i += t.amt; else if (t.type == 'Auszahlung') p.o += t.amt; else if (t.type == 'Abzug') p.i -= t.amt; });
  const l = Object.values(P).map(p => `${p.n}: **${e(p.o - p.i)}** (Buy-in ${e(p.i).replace('+', '')})`);
  const r = await fetch(HOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `**Session #${x.id}** · ${new Date(x.a).toLocaleString('de-DE')} – ${new Date(x.e).toLocaleTimeString('de-DE')}\n` + l.join('\n'), allowed_mentions: { parse: [] } }) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
}
const mtype = b => { const h = b.subarray(0, 4).toString('latin1'); return h == 'GIF8' ? 'image/gif' : h == 'RIFF' && b.subarray(8, 12).toString('latin1') == 'WAVE' ? 'audio/wav' : h.startsWith('ID3') || (b[0] == 0xff && (b[1] & 0xe0) == 0xe0) ? 'audio/mpeg' : null; }; // Inhalt prüfen, nicht die Endung
// PWA ohne Extra-Dateien: Manifest, Service Worker (App-Shell + Karten/Sounds cachen, Seite immer zuerst vom Netz) und Icons
const png = n => { // App-Icon: goldenes Pik auf dunklem Grund, einmal gerastert (zlib ist eingebaut)
  const raw = Buffer.alloc((n * 4 + 1) * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = (x + .5) / n * 2 - 1, v = (y + .5) / n * 2 - 1, hx = u / .5, hy = (v + .12) / .5, a = hx * hx + hy * hy - 1; // Herz-Kurve auf dem Kopf = Pik
    const on = a * a * a - hx * hx * hy * hy * hy <= 0 || (v > .3 && v < .72 && Math.abs(u) < (v - .3) * .5 + .04), o = (y * (n * 4 + 1)) + 1 + x * 4;
    raw.set(on ? [245, 200, 66, 255] : [20, 16, 22, 255], o);
  }
  const ch = (t, d) => { const l = Buffer.alloc(4), c = Buffer.alloc(4), td = Buffer.concat([Buffer.from(t), d]); l.writeUInt32BE(d.length); c.writeUInt32BE(zlib.crc32(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(n, 0); ih.writeUInt32BE(n, 4); ih[8] = 8; ih[9] = 6; // 8 Bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch('IHDR', ih), ch('IDAT', zlib.deflateSync(raw)), ch('IEND', Buffer.alloc(0))]);
};
const SW = `const C='poker-v1';
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(['/','/manifest.json','/icon-192.png'])));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!=C).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener('fetch',e=>{const q=e.request,u=new URL(q.url);if(q.method!='GET'||u.origin!=location.origin)return;
 if(/^\\/(cards|sounds|md|av)\\//.test(u.pathname))e.respondWith(caches.match(q).then(r=>r||fetch(q).then(n=>{if(n.ok){const k=n.clone();caches.open(C).then(c=>c.put(q,k))}return n})));
 else e.respondWith(fetch(q).then(n=>{if(n.ok&&u.pathname=='/'){const k=n.clone();caches.open(C).then(c=>c.put('/',k))}return n}).catch(()=>caches.match(q).then(r=>r||caches.match('/'))))});`;
const PWA = { '/sw.js': ['text/javascript', SW, 'no-cache'], '/icon-192.png': ['image/png', png(192)], '/icon-512.png': ['image/png', png(512)], '/icon-180.png': ['image/png', png(180)],
  '/manifest.json': ['application/manifest+json', JSON.stringify({ name: 'Poker Live', short_name: 'Poker', start_url: '/', scope: '/', display: 'standalone', background_color: '#0c0709', theme_color: '#0c0709', icons: [192, 512].map(s => ({ src: `/icon-${s}.png`, sizes: `${s}x${s}`, type: 'image/png', purpose: 'any maskable' })) })] };
const save = () => { L.un = T.un; fs.mkdirSync(__dirname + '/data', { recursive: true }); fs.writeFileSync(LF + '.tmp', JSON.stringify(L)); fs.renameSync(LF + '.tmp', LF); }; // tmp+rename: nie halb geschrieben
// Mirelo-SFX (einmalig generiert). Fehlende Dateien werden beim Start nach sounds/ geladen. Austeilen + „Du bist dran“ synthetisiert der Browser selbst.
// shortcut: Download-Links laufen am 27.10.2026 ab – danach greift im Browser die Web-Audio-Synthese.
const SFX = { flip: 'qx7d8551j8zz21ne84e39m4x6d8gn65p/0?k=Xge575WH3qPDcooK', fold: 'qx74prcarp7rg37w0fts2xh5xs8gn57h/0?k=UnoW6Lvi5gdueNLt', check: 'qx7aez90hd3bz1gng6s90kpzax8gm7mx/0?k=o2cDszAyoZNjUDYP', chips: 'qx75hnsqzw3n1tj73f4fxx0r0d8gmh9e/0?k=KUegyT0HjEr2irk1', raise: 'qx73jbdj4n8xtvk440htnbe2md8gn93p/0?k=v5x7NR9V97L1DlCG', allin: 'qx75her6crhymhh2fm2037p7w58gm95y/0?k=CLz4g8WClITJN5nZ', pot: 'qx7420rdkkm0y8q39xkfa91yr18gm7f7/0?k=PPC4uhhknK3Mxvn3', tick: 'qx7dnjzhbfv5bdkqn8tdnrnfq18gnmht/0?k=DyS-vyeXKV3G8cM0' };
fs.mkdirSync(__dirname + '/sounds', { recursive: true });
for (const [k, u] of Object.entries(SFX)) { const f = `${__dirname}/sounds/${k}.mp3`; if (!fs.existsSync(f)) fetch('https://mirelo.ai/dl/' + u).then(r => r.ok ? r.arrayBuffer() : Promise.reject('HTTP ' + r.status)).then(b => fs.writeFileSync(f, Buffer.from(b))).catch(e => console.log('Sound ' + k + ' nicht geladen (' + e + ') – Browser nutzt Synthese')); }
const T = { nm: L.nm, bp: null, pl: [], bb: 10, seven: 0, board: [], deck: [], btn: -1, live: 0, cur: 0, last: 0, turn: -1, msg: 'Warte auf Spieler …', timer: 0, sd: 0, vt: 0, ts: 0, clk: 0, ck: 0, eq: null, run: 0, rb: [], rab: null, agg: -1, ag: -1, sp: new Set(), bs: -1, hn: 0, un: L.un, arch: [], H: null, sw: null, tx: L.tx, lock: 0, sdp: 0, sdt: 0, sx: null, ro: 0, rd: 1, go: 0 };
const HN = ['High Card', 'Paar', 'Zwei Paare', 'Drilling', 'Straße', 'Flush', 'Full House', 'Vierling', 'Straight Flush'];
const sh = () => { const d = [...Array(52).keys()]; for (let i = 51; i > 0; i--) { const j = cr.randomInt(i + 1);[d[i], d[j]] = [d[j], d[i]]; } return d; };

function sc5(cs) {
  const r = cs.map(c => c % 13 + 2).sort((a, b) => b - a), fl = cs.every(c => (c / 13 | 0) == (cs[0] / 13 | 0)), n = {};
  r.forEach(x => n[x] = (n[x] || 0) + 1);
  const g = Object.keys(n).map(Number).sort((a, b) => n[b] - n[a] || b - a), wheel = r[0] == 14 && r[1] == 5;
  const st = g.length == 5 && (r[0] - r[4] == 4 || (wheel && r[2] == 4)), k = st ? (wheel ? [5, 4, 3, 2, 1] : r) : g.flatMap(x => Array(n[x]).fill(x));
  const cat = st && fl ? 8 : n[g[0]] == 4 ? 7 : n[g[0]] == 3 && n[g[1]] == 2 ? 6 : fl ? 5 : st ? 4 : n[g[0]] == 3 ? 3 : n[g[0]] == 2 && n[g[1]] == 2 ? 2 : n[g[0]] == 2 ? 1 : 0;
  return k.reduce((a, x) => a * 15 + x, cat);
}
const best = c => { let b = 0; const rec = (st, a) => { if (a.length == 5) { b = Math.max(b, sc5(a)); return; } for (let i = st; i < c.length; i++) rec(i + 1, [...a, c[i]]); }; rec(0, []); return b; };

const send = (p, o) => p.ws.readyState == 1 && p.ws.send(JSON.stringify(o));
const ev = o => T.pl.forEach(p => send(p, { t: 'e', ...o }));
const nm = u => T.nm[u] || L.dn[u] || '?', tok = p => '\x01' + p.uid + '\x02', rn = t => String(t || '').replace(/\x01(\d+)\x02/g, (_, u) => nm(u)); // Namen erst beim Anzeigen einsetzen
const pot = () => T.pl.reduce((a, q) => a + q.total, 0);
const hid = me => T.sw && !T.sw.ok.has(me); // River für diesen Betrachter noch verdeckt (Sweat läuft)
const mb = (b, me) => hid(me) && b.length == 5 ? [...b.slice(0, 4), -1] : b;
const rbs = me => T.rb.map((b, r) => T.sw && r == T.sw.r ? mb(b, me) : b);
const chips = q => q.stack + (T.live ? q.total : 0) + (q.add | 0); // total ist nach Handende schon verteilt
const rbMax = p => Math.max(0, Math.max(...T.pl.map(chips)) - chips(p)); // Rebuy bis zum größten Stack
const hcat = (q, me) => { if (!q.hole.length || q.folded) return -1; const c = [...q.hole, ...mb(T.board, me).filter(x => x >= 0)]; return c.length < 5 ? (c[0] % 13 == c[1] % 13 ? 1 : 0) : Math.floor(best(c) / 759375); }; // 0 High Card … 8 Straight Flush
const net = q => (q.net || []).reduce((a, x) => a + x, 0); // Ergebnis der letzten 10 Hände
const V = me => ({
  t: 's', me, mp: Object.entries(T.nm).map(([u, n]) => ({ u: +u, n, b: T.pl.some(q => q.uid == u) ? 1 : 0, a: (L.av[u] || {}).v || 0, m: Object.fromEntries(Object.entries(L.md[u] || {}).map(([s, x]) => [s, x.v])) })), mn: me >= 0 ? T.nm[T.pl[me].uid] : '', hn: T.hn, bb: T.bb, live: T.live, board: mb(T.board, me), rbm: me >= 0 ? rbMax(T.pl[me]) : 0, s7n: T.sevenNext == null ? -1 : T.sevenNext, pot: T.pl.reduce((a, q) => a + q.total - (T.live ? q.bet : 0), 0), turn: T.turn, cur: T.cur, // Pot ohne laufende Einsätze: die wandern erst am Rundenende hinein
  min: Math.max(T.cur * 2, T.bb), ra: me >= 0 && !T.pl[me].acted ? 1 : 0, hs: me >= 0 ? hcat(T.pl[me], me) : -1, jm: T.pl.length ? Math.max(100 * T.bb, ...T.pl.map(chips)) : 0, btn: T.btn, sd: T.sd, eq: T.eq, sdp: T.sdp ? T.sdp - Date.now() : 0, sdpEnd: T.sdp, sai: T.sdp && T.sx && T.sx.last >= 0 && T.pl[T.sx.last].allin ? 1 : 0, now: Date.now(), train: T.train | 0, trn: T.trainNext == null ? -1 : T.trainNext, sde: T.sdp ? T.pl.map((q, i) => i != T.sx.last && !q.folded && q.bet + q.stack > T.cur ? i : -1).filter(i => i >= 0) : [], sw: T.sw && T.sw.who.includes(me) && !T.sw.ok.has(me) ? { k: T.sw.ts, el: Date.now() - T.sw.ts, c: T.sw.c } : null, run: T.run, rb: rbs(me), rr: T.rr ? T.rr.map(rn) : null, rab: !T.live && T.rab ? T.rab.length : 0, vt: T.vt ? T.vt - Date.now() : 0, cl: T.clk ? T.clk - Date.now() : 0, el: T.ts ? Date.now() - T.ts : 0, msg: rn(T.msg), bp: T.bp ? { left: T.bp.until - Date.now(), who: T.bp.who.map(nm), me: me >= 0 && T.bp.who.includes(T.pl[me].uid) } : null, seven: T.seven, rd: T.rd && !T.live ? 1 : 0,
  pl: T.pl.map((q, i) => ({ rdy: q.rdy ? 1 : 0, u: q.uid, name: q.name, seat: q.seat, stack: q.stack, bet: q.bet, folded: q.folded, allin: q.allin, in: q.hole.length > 0, c: (i == me || q.show) ? q.hole : null, w: q.won, sh: q.show ? 1 : 0, stw: q.stw | 0, sg: (T.live ? q.stx : q.stw) | 0, vt: T.vt && !q.folded && q.hole.length ? q.v | 0 : -1, hot: (q.wst | 0) >= 3 || net(q) >= 40 * T.bb ? 1 : 0, cold: (q.lst | 0) >= 5 || net(q) <= -40 * T.bb ? 1 : 0, vp: q.hn ? Math.round((q.vn | 0) / q.hn * 100) : null, gh: q.ghost ? 1 : 0, bcall: q.bcall ? 1 : 0, out: q.out ? 1 : 0, so: q.so ? 1 : 0, tr: T.tr && T.tr.uid == q.uid ? T.tr.n : 0 }))
});
const endSess = () => { const x = { id: (L.ss.length ? L.ss[L.ss.length - 1].id : 0) + 1, a: T.tx[0].ts, e: Date.now(), tx: T.tx.splice(0), sx: 0 }; L.ss.push(x); save(); // splice: T.tx bleibt dasselbe Array wie L.tx
  const us = new Set(x.tx.map(t => t.uid)); wss.clients.forEach(w => w.readyState == 1 && us.has(w.pu) && w.send(JSON.stringify({ t: 'e', k: 'ssq', id: x.id }))); }; // Teilnehmer fragen: Dashboard-Sync oder Spaßrunde (sx: 0 offen, 1 übertragen, 2 Spaßrunde)
const bc = () => { if (!T.pl.length && T.tx.length) endSess(); // Tisch geschlossen oder leer -> Session abhaken (jeder Abgang läuft über bc)
  T.pl.forEach((p, me) => send(p, V(me))); T.sp.forEach(w => w.readyState == 1 && w.send(JSON.stringify(V(-1)))); };
const nx = (i, f = p => !p.folded) => { for (let k = 1; k <= T.pl.length; k++) { const j = (i + k) % T.pl.length; if (f(T.pl[j])) return j; } return -1; };
const post = (p, a) => { a = Math.min(a, p.stack); p.stack -= a; p.bet += a; p.total += a; if (!p.stack) p.allin = 1; };

const tx = (p, type, amt) => { T.tx.push({ ts: Date.now(), name: p.name, uid: p.uid, type, amt }); save(); };
const rebind = (q, ws) => { const o = q.ws; if (o !== ws) { o.P = null; if (o.readyState < 2) o.terminate(); } // altes Socket vergisst den Spieler -> sein close() tut nichts
  q.ws = ws; ws.P = q; ws.pu = q.uid; T.sp.delete(ws); if (q.dso) { q.so = q.dso = 0; if (!T.live) q.ghost = 0; kick(); } send(q, { t: 'e', k: 'toast', m: 'Wieder verbunden – dein Platz ist erhalten.' }); bc(); };
setInterval(() => wss.clients.forEach(w => { if (w.al === 0) return w.terminate(); w.al = 0; w.ping(); }), 25000); // Heartbeat: hält Proxys/Tunnel wach, tote Sockets fliegen nach ~50 s
const kick = () => { if (!T.live && T.msg.startsWith('Warte')) { clearTimeout(T.timer); T.timer = setTimeout(start, 800); } };
const payout = p => { const v = Math.max(0, p.stack + (p.add | 0) - (p.sub | 0)); if (v > 0) tx(p, 'Auszahlung', v); p.stack = p.add = p.sub = 0; }; // inkl. offener Rebuys/Korrekturen, nur einmal
function cashout(p) { bpOk(p); payout(p); T.pl = T.pl.filter(q => q !== p); p.ws.P = null; T.sp.add(p.ws); bc(); }
function closeTable() { // Tisch schließen: laufende Hand abbrechen (Einsätze zurück), alle auszahlen, alle werden Zuschauer
  T.bp = null; clearTimeout(T.timer); clearTimeout(T.ck); clearTimeout(T.ck2); clearTimeout(T.sdt); clearTimeout(T.swt); T.sdp = 0; T.sx = null; T.ro = 0; T.lock = Date.now() + 7000;
  if (T.H) { T.H.res = 'Abgebrochen – Tisch geschlossen'; T.H.win = []; T.H.total = pot(); T.H.board = T.board.slice(); T.H.boards = []; T.arch.push(T.H); T.H = null; }
  // Einsätze nur bei laufender Hand erstatten – nach Handende sind sie schon verteilt (sonst doppelte Auszahlung)
  T.pl.forEach(q => { if (T.live) q.stack += q.total; q.total = 0; payout(q); q.ws.P = null; T.sp.add(q.ws); });
  T.pl = []; T.live = 0; T.rd = 1; T.go = 0; T.turn = -1; T.board = []; T.rb = []; T.rr = null; T.eq = null; T.sw = null; T.vt = 0; T.clk = 0; T.btn = -1; T.bs = -1; T.msg = 'Tisch geschlossen'; T.bp = null; bc();
}
const rec = (p, a, to) => { const H = T.H; if (H) H.ev.push({ ph: H.ph, uid: p.uid, name: p.name, pos: (H.pl.find(q => q.uid == p.uid) || {}).pos, a, to }); };
const hph = n => { const ph = { 3: 'Flop', 4: 'Turn', 5: 'River' }[n], H = T.H; if (ph && H && H.pots[ph] == null) { H.ph = ph; H.pots[ph] = pot(); } };
function finH() { // Hand ins Archiv
  const H = T.H; if (!H) return; H.res = T.msg; H.win = T.lastW || []; H.wa = Object.fromEntries(T.pl.filter(q => q.won > 0).map(q => [q.uid, q.won])); H.total = pot(); H.board = T.board.slice(); H.boards = T.rb.length > 1 ? T.rb.map(b => b.slice()) : [];
  H.shown = H.pl.filter(q => T.pl.some(p => p.uid == q.uid && p.show)).map(q => q.seat); T.arch.push(H); T.H = null;
}
function hv(id, p) { // Hand-Ansicht: nur gezeigte + eigene Karten
  const H = id > 0 ? T.arch.find(h => h.id == id) : (T.H || T.arch[T.arch.length - 1]); if (!H) return null;
  return { id: H.id, ts: H.ts, bb: H.bb, res: rn(H.res), pots: H.pots, ev: H.ev.map(e => ({ ...e, name: nm(e.uid) })), live: H == T.H, me: p ? p.uid : 0, wu: H.win || [], wa: H.wa || {}, board: H.board || mb(T.board, T.pl.indexOf(p)), boards: H.boards || (T.rb.length > 1 ? rbs(T.pl.indexOf(p)) : []),
    pl: H.pl.map(q => ({ seat: q.seat, name: nm(q.uid), uid: q.uid, pos: q.pos, c: (H.shown.includes(q.seat) || (p && q.uid == p.uid)) ? q.hole : null })) };
}
function start() {
  if (T.sevenNext != null) { T.seven = T.sevenNext; T.sevenNext = null; }
  if (T.trainNext != null) { T.train = T.trainNext; T.trainNext = null; if (!T.train) T.tr = null; }
  T.pl.filter(q => q.out).forEach(cashout);
  T.pl = T.pl.filter(p => !p.gone); T.pl.sort((a, b) => a.seat - b.seat); T.btn = T.pl.reduce((r, p, i) => p.seat <= T.bs ? i : r, -1);
  T.pl.forEach(p => { p.stack = Math.max(0, p.stack + p.add - (p.sub | 0)); p.add = 0; p.sub = 0; p.h0 = p.stack; p.bcall = 0; p.ghost = p.so ? 1 : 0; p.hole = []; p.show = p.won = p.bet = p.total = p.allin = p.acted = p.vol = p.stx = 0; p.folded = p.stack <= 0 || p.ghost ? 1 : 0; });
  let act = T.pl.filter(p => !p.folded);
  if (act.length < 2) { T.live = 0; T.rd = 1; T.go = 0; T.msg = 'Warte auf Spieler …'; return bc(); } // Pause -> vor der nächsten Hand wieder Bereit-Runde
  if (T.rd) { // Bereit-Runde: erst wenn alle bereit sind oder ein Bereiter „Trotzdem starten“ drückt (Nicht-Bereite setzen aus)
    const nr = act.filter(p => !p.rdy); if (nr.length && !T.go) { T.live = 0; T.msg = 'Warte auf Bereit …'; return bc(); }
    nr.forEach(p => { p.so = p.ghost = p.folded = 1; }); act = act.filter(p => p.rdy); T.rd = T.go = 0; T.pl.forEach(p => p.rdy = 0);
  }
  T.live = 1; T.board = []; T.deck = sh(); T.msg = ''; T.sd = 1; T.rb = []; T.rr = null; T.rab = null; T.agg = -1; T.ag = -1; T.eq = null; T.run = 0; T.vt = 0; T.clk = 0; T.ro = 0; T.sdp = 0;
  T.btn = nx(T.btn); T.bs = T.pl[T.btn].seat;
  const sb = act.length == 2 ? T.btn : nx(T.btn), bb = nx(sb);
  post(T.pl[sb], T.bb / 2); post(T.pl[bb], T.bb);
  T.cur = T.bb; T.last = T.bb; T.turn = -1; T.sx = { act, sb, bb, chain: [], k: 0 };
  ev({ k: 'deal', sb: T.pl[sb].name, bb: T.pl[bb].name, bbn: T.bb });
  { const k = act.indexOf(T.pl[sb]), ord = act.slice(k).concat(act.slice(0, k)), N = ord.length;
    const PN = { 3: ['BTN'], 4: ['CO', 'BTN'], 5: ['UTG', 'CO', 'BTN'], 6: ['UTG', 'HJ', 'CO', 'BTN'], 7: ['UTG', 'MP', 'HJ', 'CO', 'BTN'], 8: ['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN'], 9: ['UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO', 'BTN'] };
    const nm = N == 2 ? ['BTN/SB', 'BB'] : ['SB', 'BB', ...PN[N]];
    T.H = { id: ++T.hn, ts: Date.now(), bb: T.bb, ph: 'Blinds', pots: {}, ev: [], shown: [], pl: ord.map((p, i) => ({ seat: p.seat, uid: p.uid, name: p.name, hole: [], pos: nm[i] })) };
    rec(T.pl[sb], 'sb', T.pl[sb].bet); rec(T.pl[bb], 'bb', T.pl[bb].bet); }
  const u = nx(bb), chain = []; { let i = u; do { chain.push(i); i = nx(i); } while (i !== u); } // Reihenfolge: UTG … BTN, SB, BB
  T.sx.chain = chain; let k = 0; // jeder Vorgemerkte straddelt (mind. doppelt), Aktion beginnt links vom letzten Straddler
  chain.forEach((ci, j) => {
    const x = T.pl[ci], to = Math.min(Math.max(x.stw, T.cur * 2), x.bet + x.stack); if (!x.stw) return;
    if (to <= T.cur) { x.stw = 0; send(x, { t: 'e', k: 'toast', m: 'Straddle entfällt – Stack zu klein.' }); return; } // All-in unter dem Doppelten ist erlaubt
    post(x, to - x.bet); T.cur = x.bet; x.stx = x.bet; x.stw = 0; rec(x, 'straddle', x.bet); ev({ k: 'a', i: ci, a: 'straddle', to: x.bet, pot: pot() }); k = j + 1;
  });
  T.sx.k = k; T.sx.last = k ? chain[k - 1] : -1;
  if (k > 0) { T.sdp = Date.now() + 10000; clearTimeout(T.sdt); T.sdt = setTimeout(endSd, 10000); return bc(); } // nach jedem Straddle 10 s Re-Straddle-Fenster
  endSd();
}
function endSd() { // Straddle-Phase vorbei -> Karten austeilen
  if (Date.now() < T.lock || !T.sx) return; T.sdp = 0; const { last, bb } = T.sx;
  T.pl.forEach(p => { if (!p.folded) p.hole = [T.deck.pop(), T.deck.pop()]; });
  T.H.pl.forEach(q => { const p = T.pl.find(x => x.uid == q.uid); if (p) q.hole = p.hole.slice(); });
  T.last = T.bb; T.turn = last >= 0 ? last : bb; T.H.ph = 'Preflop'; T.H.pots.Preflop = pot(); T.sx = null; T.bcCur = T.cur; // Aktion beginnt links vom letzten Straddler
  nxt();
}
function nxt() {
  const L = T.pl.filter(p => !p.folded); if (L.length < 2) return fin();
  const can = L.filter(p => !p.allin), op = p => !p.folded && !p.allin && (p.bet < T.cur || (!p.acted && can.length > 1));
  const j = nx(T.turn, op); if (j >= 0) { T.turn = j; T.ts = Date.now(); const q = T.pl[j];
    if (q.bcall) { q.bcall = 0; if (!T.board.length && T.cur == T.bcCur) setTimeout(() => act(q, { a: T.cur > q.bet ? 'call' : 'check' }), 400); } // Blind Call
    return bc(); }
  T.pl.forEach(p => { p.bet = 0; p.acted = 0; }); T.cur = 0; T.last = T.bb; T.turn = -1; T.ag = T.agg; T.agg = -1; bc(); setTimeout(st, 700);
}
function st() {
  if (Date.now() < T.lock || T.vt || T.ro) return;
  const n = T.board.length; if (n == 5) return showdown();
  if (T.pl.filter(p => !p.folded && !p.allin).length < 2) return vote(); // alle All-in -> Abstimmung
  for (let i = 0; i < (n ? 1 : 3); i++) T.board.push(T.deck.pop());
  hph(T.board.length); ev({ k: 'street', n: T.board.length, pot: pot() }); T.turn = nx(T.btn, p => !p.folded && !p.allin); T.ts = Date.now(); bc();
}
function showdown() { // Reihenfolge: letzter Aggressor, sonst links vom Button, dann reihum
  const n = T.pl.length, f = (T.ag >= 0 && !T.pl[T.ag].folded) ? T.ag : nx(T.btn);
  const ord = T.pl.map((p, i) => i).filter(i => !T.pl[i].folded).sort((a, b) => ((a - f + n) % n) - ((b - f + n) % n));
  T.turn = -1; bc(); ord.forEach((i, k) => setTimeout(() => { if (Date.now() < T.lock || !T.pl[i]) return; T.pl[i].show = 1; ev({ k: 'show', i }); bc(); }, (k + 1) * 1200));
  setTimeout(() => sd([T.board.slice()]), (ord.length + 1) * 1200);
}
function pay(w, amt) { const s = Math.floor(amt / w.length / 5) * 5; w.forEach(p => { p.stack += s; p.won += s; }); const r = amt - s * w.length; w[0].stack += r; w[0].won += r; }
function eqs() { // Equity (Monte Carlo) + Outs
  const L = T.pl.map((p, i) => (!p.folded && p.hole.length) ? i : -1).filter(i => i >= 0), used = new Set([...T.board, ...L.flatMap(i => T.pl[i].hole)]);
  const rest = [...Array(52).keys()].filter(c => !used.has(c)), need = 5 - T.board.length, N = need == 1 ? rest.length : need ? 700 : 1, w = L.map(() => 0);
  for (let s = 0; s < N; s++) {
    const d = rest.slice(), b = T.board.slice();
    if (need == 1) b.push(rest[s]); // Turn: alle River-Karten exakt durchrechnen
    else for (let k = 0; k < need; k++) { const j = k + Math.floor(Math.random() * (d.length - k)); [d[k], d[j]] = [d[j], d[k]]; b.push(d[k]); }
    const sc = L.map(i => best([...T.pl[i].hole, ...b])), m = Math.max(...sc), t = sc.filter(x => x == m).length; sc.forEach((x, k) => { if (x == m) w[k] += 1 / t; });
  }
  const outs = L.map(() => []), fo = L.map(() => []), cur = T.board.length >= 3 ? L.map(i => best([...T.pl[i].hole, ...T.board])) : null;
  if (cur && need) rest.forEach(c => { const sc = L.map(i => best([...T.pl[i].hole, ...T.board, c])), m = Math.max(...sc); if (sc.filter(x => x == m).length == 1) { const k = sc.indexOf(m); if (cur[k] < Math.max(...cur)) { outs[k].push(c); if (Math.floor(m / 759375) == 5) fo[k].push(c); } } }); // fo: Out, dessen bestes Ergebnis ein Flush ist
  const r = T.pl.map(() => null), mw = Math.max(...w); L.forEach((i, k) => r[i] = { e: Math.round(w[k] / N * 1000) / 10, o: outs[k], f: fo[k], lead: w[k] == mw }); return r;
}
function vote() {
  if (T.vt) return; clearTimeout(T.ck2);
  T.pl.forEach(p => { if (!p.folded) { p.show = 1; p.v = 0; } }); T.vt = Date.now() + 30000; T.turn = -1; T.eq = eqs(); bc(); T.ck2 = setTimeout(tally, 30000);
}
function tally() {
  if (!T.vt) return; // nur einstimmig -> Run it 2x/3x
  clearTimeout(T.ck2); T.vt = 0; T.ro = 1; bc(); const v = T.pl.filter(p => !p.folded).map(p => p.v || 1); runout(v.every(x => x == v[0]) ? v[0] : 1);
}
function runout(R) {
  const base = T.board.slice(), runs = [], fr = []; T.rb = [];
  for (let r = 0; r < R; r++) { const b = base.slice(); while (b.length < 5) b.push(T.deck.pop()); runs.push(b); }
  runs.forEach((b, r) => [3, 4, 5].filter(l => l > base.length).forEach(l => fr.push({ b: b.slice(0, l), r })));
  let i = 0; const step = () => { if (Date.now() < T.lock) return;
    if (i >= fr.length) return sd(runs);
    const f = fr[i++]; T.board = f.b; T.rb[f.r] = f.b; T.run = R > 1 ? f.r + 1 : 0; hph(f.b.length); T.sw = null;
    let pre = null; if (f.b.length == 5) { T.board = f.b.slice(0, 4); pre = eqs(); T.board = f.b; } // Equity VOR dem River
    // Sweat nur für Spieler mit echter Chance (0 % < Equity < 100 %); wer 0 % hat, sieht den River sofort
    const who = pre ? pre.map((q, k) => q && q.e > 0 && q.e < 100 ? k : -1).filter(k => k >= 0) : [];
    if (who.length) {
      T.sw = { ts: Date.now(), c: f.b[4], r: f.r, who, ok: new Set(pre.map((q, k) => q && !who.includes(k) ? k : -1).filter(k => k >= 0)) };
      T.eq = pre; T.swNext = step; T.swt = setTimeout(swEnd, 10000); // 8 s Sweat + Flip-Puffer
      ev({ k: 'street', n: 5, pot: pot() }); return bc();
    }
    T.eq = eqs(); ev({ k: 'street', n: T.board.length, pot: pot() }); bc();
    setTimeout(step, f.b.length == 5 ? 2500 : 1800);
  }; ev({ k: 'rit', n: R }); setTimeout(step, 3000); // 3 s Banner, dann Board
}
function swEnd() { clearTimeout(T.swt); if (!T.sw) return; T.sw = null; T.eq = eqs(); bc(); setTimeout(T.swNext, 2500); } // alle sehen den River
function sd(bs) {
  if (Date.now() < T.lock) return;
  T.ro = 0;
  T.sw = null;
  const L = T.pl.filter(p => !p.folded); L.forEach(p => p.show = 1);
  const MW = new Set(), R = bs.length, lv = [...new Set(L.map(p => p.total))].sort((a, b) => a - b), pots = [], W = new Set(), res = []; let prev = 0;
  for (const l of lv) { pots.push({ amt: T.pl.reduce((a, p) => a + Math.max(0, Math.min(p.total, l) - prev), 0), el: L.filter(p => p.total >= l) }); prev = l; }
  bs.forEach((b, r) => {
    L.forEach(p => p.s = best([...p.hole, ...b])); const rw = new Set();
    pots.forEach((o, oi) => { const q = Math.floor(o.amt / R / 5) * 5, sh = q + (r == 0 ? o.amt - q * R : 0), m = Math.max(...o.el.map(p => p.s)), w = o.el.filter(p => p.s == m).sort((a, b) => ((T.pl.indexOf(a) - T.btn - 1 + T.pl.length) % T.pl.length) - ((T.pl.indexOf(b) - T.btn - 1 + T.pl.length) % T.pl.length)); pay(w, sh); w.forEach(p => { W.add(p); rw.add(p); if (!oi) MW.add(p); }); });
    const t = [...rw].sort((a, b) => b.s - a.s)[0]; res.push([...rw].map(tok).join(' & ') + ' (' + HN[Math.floor(t.s / 759375)] + ')');
  });
  T.rr = R > 1 ? res : null; // Gewinner je Run, bleibt bis zur nächsten Hand
  done([...W], R > 1 ? res.map((x, i) => 'Run ' + (i + 1) + ': ' + x).join(' · ') : res[0].replace(/^.*\(/, '').replace(')', ''), MW.size == 1 ? [...MW][0] : null, pots[0].amt);
}
function fin() { const w = T.pl.find(p => !p.folded), need = 5 - T.board.length; T.rab = need ? T.deck.slice(-need).reverse() : null; const t = T.pl.reduce((a, p) => a + p.total, 0); pay([w], t); done([w], '', w, t); }
function done(W, h, tw, mp) { // tw = Train-Sieger (allein Main Pot) oder null (Split = Serie unterbrochen); mp = Hauptpot
  T.lastW = W.map(p => p.uid);
  T.live = 0; T.turn = -1; T.eq = null; T.run = 0; T.clk = 0; clearTimeout(T.ck); clearTimeout(T.sdt); T.sdp = 0; T.sx = null;
  if (T.seven && W.length == 1 && W[0].hole.map(c => c % 13 + 2).sort((a, b) => a - b).join() == '2,7') { // 7-2-Regel
    const w = W[0]; w.show = 1; let tot = 0;
    T.pl.forEach(p => { if (p != w) { const a = Math.min(p.stack, T.seven); p.stack -= a; tot += a; } });
    w.stack += tot; w.won += tot; h = '7-2 Bonus!';
  }
  if (T.train) { // The Train: 3 Hände in Folge
    T.tr = !tw ? null : T.tr && T.tr.uid == tw.uid ? { uid: tw.uid, n: T.tr.n + 1 } : { uid: tw.uid, n: 1 };
    if (T.tr && T.tr.n >= 3) {
      let tot = 0;
      T.pl.forEach(p => { if (p == tw || p.ghost || p.gone || p.out) return; const miss = T.train - p.stack; if (miss > 0) { tx(p, 'Rebuy (Train)', miss); p.stack += miss; } p.stack -= T.train; tot += T.train; }); // zu wenig Stack -> Rest automatisch nachgekauft
      tw.stack += tot; tw.won += tot; h = (h ? h + ' · ' : '') + '🚂 Train!'; T.tr = null;
    }
  }
  T.msg = W.map(tok).join(' & ') + ' gewinnt' + (h ? ' – ' + h : '');
  T.pl.forEach(q => { if (q.hole.length) { q.hn = (q.hn | 0) + 1; if (q.vol) q.vn = (q.vn | 0) + 1; if (q.won > 0) { q.wst = (q.wst | 0) + 1; q.lst = 0; } else if (q.vol) { q.lst = (q.lst | 0) + 1; q.wst = 0; } q.net = [...(q.net || []), q.stack - q.h0].slice(-10); } }); // NICHT q.ws – das ist der WebSocket
  finH();
  const bust = T.pl.filter(q => q.hole.length && q.stack + (q.add | 0) <= 0 && !q.gone && !q.out);
  ev({ k: 'win', w: W.map(p => T.pl.indexOf(p)), a: W.map(p => p.won), msg: rn(T.msg), pot: pot(), vm: !bust.length && mp >= 50 * T.bb ? 1 : 0 }); // vm: Sieges-Musik nur ab 50 BB Hauptpot und nicht bei einem Kill
  // Pleite-Pause: ab 3 Spielern bekommt jeder, der gerade auf 0 gefallen ist, 30 s für Rebuy oder Aussetzen
  bust.forEach(b => W.filter(w => w !== b).forEach(w => { w.kc = (w.kc | 0) + 1; ev({ k: 'kill', i: T.pl.indexOf(w), v: T.pl.indexOf(b), n: w.kc }); })); // Kill-Zähler pro Sitzung am Tisch -> Kill-Sound #1–#5 im Browser
  if (bust.length && T.pl.filter(q => !q.ghost && !q.gone).length > 2) { T.bp = { until: Date.now() + 30000, min: Date.now() + 6000, who: bust.map(q => q.uid) }; T.timer = setTimeout(bpEnd, 30000); }
  else T.timer = setTimeout(start, 6000);
  bc();
}
function bpEnd() { // Pause vorbei: wer nicht entschieden hat, wird Geist; dann geht's weiter
  if (!T.bp) return; clearTimeout(T.timer); T.pl.forEach(q => { if (T.bp.who.includes(q.uid)) q.ghost = q.so = 1; });
  const w = Math.max(0, T.bp.min - Date.now()); T.bp = null; T.timer = setTimeout(start, w); bc();
}
const bpOk = p => { if (!T.bp) return; T.bp.who = T.bp.who.filter(u => u != p.uid); if (!T.bp.who.length) bpEnd(); };
function act(p, m) {
  if (!T.live || T.pl.indexOf(p) != T.turn) return;
  const need = T.cur - p.bet; let a = m.a, bet = 0;
  if (a == 'straddle') return; // nach dem Austeilen gesperrt
  if (a == 'fold') p.folded = 1;
  else if (a == 'check') { if (need) return; }
  else if (a == 'call') post(p, need);
  else if (a == 'raise') {
    const mx = p.bet + p.stack, to = Math.min(Math.round(m.amt / 5) * 5, mx), mn = Math.max(T.cur * 2, T.bb);
    if (p.acted || !(to > T.cur) || (to < mn && to < mx)) return; // mind. 2x die aktuelle Bet, außer All-in; wer schon gehandelt hat, darf nach kurzem All-in nicht neu raisen
    if (to >= mn) T.pl.forEach(q => q.acted = 0); // nur ein volles Raise eröffnet die Action neu
    bet = !T.cur; T.cur = to; post(p, to - p.bet);
    T.agg = T.pl.indexOf(p);
  } else return;
  if (!T.board.length && m.a != 'fold' && m.a != 'check') p.vol = 1; p.acted = 1; T.sd = 0; clearTimeout(T.ck); T.clk = 0; if (p.allin && a != 'fold') a = 'allin';
  rec(p, a, p.bet); ev({ k: 'a', i: T.pl.indexOf(p), a, b: bet ? 1 : 0, to: p.bet, pot: pot() }); nxt(); // b: erste Bet der Runde -> Ansage „Bet“
}
const cents = v => Math.max(0, Math.round((+v || 0) * 20) * 5);
wss.on('connection', ws => {
  let p; ws.al = 1; ws.on('pong', () => ws.al = 1); T.sp.add(ws); bc(); // Zuschauer sehen sofort den Tisch
  ws.on('message', d => {
    let m; try { m = JSON.parse(d); } catch { return; }
    p = ws.P;
    if (m.t == 'join' && !p && T.pl.length < 9) {
      const uid = m.uid | 0; // Konto = gewählter Hauptname
      if (!T.nm[uid]) return ws.send(JSON.stringify({ t: 'e', k: 'err', m: 'Bitte einen Spieler aus der Liste wählen.' }));
      ws.pu = uid; // für die Abfrage beim Session-Ende
      const old = T.pl.find(q => q.uid == uid); if (old && old.ws.readyState != 1) return rebind(old, ws); // Platz eines Getrennten übernehmen (anderes Gerät)
      if (old) return ws.send(JSON.stringify({ t: 'e', k: 'err', m: T.nm[uid] + ' sitzt schon am Tisch oder seine letzte Hand läuft noch.' }));
      const c = T.pl.length ? cents(m.buyin) : Math.max(100, cents(m.buyin)), jm = Math.max(100 * T.bb, ...T.pl.map(chips)); // Späteinsteiger: 40 BB bis Match Stack
      if (T.pl.length && (c < 40 * T.bb || c > jm)) return ws.send(JSON.stringify({ t: 'e', k: 'err', m: 'Buy-in: mindestens 40 BB (' + (40 * T.bb / 100).toFixed(2) + ' €), höchstens Match Stack (' + (jm / 100).toFixed(2) + ' €).' }));
      if (!T.pl.length) { T.bb = Math.max(5, Math.round(c / 500) * 5); T.seven = m.seven ? cents(m.seven) : 0; } // 100 BB Starting Stack
      p = { ws, uid, seat: [0, 1, 2, 3, 4, 5, 6, 7, 8].find(k => !T.pl.some(q => q.seat === k)), name: T.nm[uid], pid: /^[0-9a-f]{32}$/.test(m.pid) ? m.pid : '', stack: c, add: 0, hole: [], bet: 0, total: 0, folded: 1, allin: 0, acted: 0, show: 0, won: 0 };
      T.pl.push(p); T.sp.delete(ws); ws.P = p; tx(p, 'Buy-in', c); if (!T.live && !T.bp) { clearTimeout(T.timer); T.timer = setTimeout(start, Math.max(1000, T.lock - Date.now())); } bc();
    } else if (m.t == 're' && !p) { const q = m.pid && T.pl.find(x => x.pid == m.pid); if (q) rebind(q, ws); } // Reconnect desselben Browsers
    else if (m.t == 'act' && p) act(p, m);
    else if (m.t == 'arch') ws.send(JSON.stringify({ t: 'e', k: 'archl', l: T.arch.slice(-100).map(h => ({ id: h.id, ts: h.ts, bb: h.bb, res: rn(h.res), pot: h.total, win: (h.win || []).map(nm), c: ((p && h.pl.find(x => x.uid == p.uid)) || {}).hole || null })) }));
    else if (m.t == 'hand') ws.send(JSON.stringify({ t: 'e', k: 'hand', h: hv(m.id | 0, p) }));
    else if (m.t == 'rs' && p && T.sdp) { // Re-Straddle in der 10-s-Phase
      const ix = T.pl.indexOf(p); if (ix == T.sx.last || p.folded) return;
      const amt = Math.min(Math.round(m.amt / 5) * 5, p.bet + p.stack);
      if (amt < T.cur * 2 && !(amt == p.bet + p.stack && amt > T.cur)) return send(p, { t: 'e', k: 'err', m: 'Re-Straddle: mindestens das Doppelte (' + (T.cur * 2 / 100).toFixed(2) + ' €) oder All-in.' });
      T.pl.forEach(q => { if (q.bcall && q !== p) send(q, { t: 'e', k: 'toast', m: 'Blind Call verfällt – neuer Re-Straddle.' }); q.bcall = 0; }); // höchster Straddle ist jetzt ein anderer
      post(p, amt - p.bet); T.cur = p.bet; p.stx = p.bet; p.stw = 0; T.sx.last = ix; rec(p, 'straddle', p.bet); ev({ k: 'a', i: ix, a: 'straddle', to: p.bet, pot: pot() });
      clearTimeout(T.sdt); T.sdp = Date.now() + 10000; T.sdt = setTimeout(endSd, 10000); bc(); // Timer zurück auf 10 s
    }
    else if (m.t == 'sw' && p && T.sw) { // dieser Spieler hat seinen River aufgedeckt
      const i = T.pl.indexOf(p); if (!T.sw.who.includes(i)) return; T.sw.ok.add(i);
      if (T.sw.who.every(j => T.sw.ok.has(j))) swEnd(); else bc();
    }
    else if (m.t == 'seven' && p) { // 7-2-Regel live ändern
      const a = m.amt > 0 ? cents(m.amt) : 0; if (T.live) T.sevenNext = a; else T.seven = a;
      ev({ k: 'toast', m: p.name + ': 7-2-Regel ' + (a ? 'AN (' + (a / 100).toFixed(2).replace('.', ',') + ' € pro Spieler)' : 'AUS') + (T.live ? ' – gilt ab der nächsten Hand' : '') }); bc();
    }
    else if (m.t == 'straddle' && p) { p.stw = m.amt > 0 ? Math.max(Math.round(m.amt / 5) * 5, T.bb * 2) : 0; bc(); }
    else if (m.t == 'rabbit' && p && !T.live && T.rab && p.hole.length) send(p, { t: 'e', k: 'rab', c: T.rab }); // nur an den Anfragenden
    else if (m.t == 'emote' && p) ev({ k: 'emote', i: T.pl.indexOf(p), e: m.e | 0 });
    else if (m.t == 'show' && p && !T.live && p.hole.length) { p.show = 1; const L = T.arch[T.arch.length - 1]; if (L && !L.shown.includes(p.seat) && L.pl.some(q => q.uid == p.uid)) L.shown.push(p.seat); bc(); }
    else if (m.t == 'vote' && p && T.vt && !p.folded && p.hole.length) { p.v = [1, 2, 3].includes(m.n) ? m.n : 1; if (T.pl.filter(q => !q.folded && q.hole.length).every(q => q.v)) tally(); else bc(); } // live: alle sehen die Wahl
    else if (m.t == 'clock' && p && T.live && T.turn >= 0 && !p.folded && p.hole.length && T.pl[T.turn] != p && !T.clk && Date.now() - T.ts >= 90000) { // Call Clock: ein Mitspieler löst sie aus, frühestens nach 90 s Inaktivität (jede Phase)
      const tg = T.pl[T.turn], hn = T.hn; T.clk = Date.now() + 60000;
      T.ck = setTimeout(() => { if (!T.live || T.pl[T.turn] !== tg || T.hn != hn) return; tg.so = 1; send(tg, { t: 'e', k: 'toast', m: 'Call Clock abgelaufen – gefoldet. Du setzt aus, bis du wieder einsteigst.' }); act(tg, { a: 'fold' }); }, 60000); bc(); } // danach Fold + Aussetzen
    else if (m.t == 'rebuy' && p) { // Rebuy: 40–100 BB
      const c = cents(m.amt), mx = rbMax(p);
      if (c <= 0 || c > mx || (c < 40 * T.bb && c !== mx)) return send(p, { t: 'e', k: 'err', m: 'Rebuy: mindestens 40 BB und höchstens bis zum größten Stack (aktuell max. ' + (mx / 100).toFixed(2) + ' €).' });
      if (p.stack + (p.add | 0) <= 0) p.so = 0; if (!T.live) p.ghost = p.so ? 1 : 0;
      tx(p, 'Rebuy', c); if (T.live) p.add += c; else p.stack += c; bpOk(p); kick(); bc();
    }
    else if (m.t == 'deduct' && p) { // Korrektur: Betrag vom eigenen Stack abziehen
      const c = Math.min(cents(m.amt), p.stack + (p.add | 0)); if (c <= 0) return;
      tx(p, 'Abzug', c); if (T.live && !p.folded) p.sub = (p.sub | 0) + c; else p.stack = Math.max(0, p.stack - c); bc();
    }
    else if (m.t == 'cash' && p) { if (T.live) { p.out = 1; send(p, { t: 'e', k: 'toast', m: 'Du verlässt den Tisch nach dieser Hand – dann wird dein Stack ausgezahlt.' }); bc(); } else cashout(p); } // Cashout: laufende Hand zu Ende spielen
    else if (m.t == 'stay' && p && p.out) { p.out = 0; send(p, { t: 'e', k: 'toast', m: 'Du bleibst am Tisch.' }); bc(); } // Verlassen storniert
    else if (m.t == 'bcall' && p && T.sdp && !p.folded && T.sx.last >= 0 && T.pl[T.sx.last].allin && T.pl.indexOf(p) != T.sx.last) { p.bcall = m.on ? 1 : 0; bc(); } // nur gegen einen All-in-Straddle
    else if (m.t == 'tx' && p) send(p, { t: 'e', k: 'txl', l: T.tx.map(t => ({ ...t, name: nm(t.uid) })), st: Object.fromEntries(T.pl.filter(q => !q.gone && !q.out).map(q => [q.uid, q.stack + (T.live ? q.total : 0) + (q.add | 0) - (q.sub | 0)])) });
    else if (m.t == 'rdy' && p && T.rd && !T.live) { p.rdy = m.on ? 1 : 0; if (m.on) p.so = p.ghost = 0; // Bereit = auch nicht mehr aussetzen
      if (m.go && p.rdy && T.pl.filter(q => q.rdy).length >= 2) T.go = 1; kick(); bc(); }
    else if (m.t == 'sitout' && p) { p.so = m.on ? 1 : 0; if (!T.live) p.ghost = p.so; bpOk(p); kick(); bc(); } // Aussetzen / wieder einsteigen: greift ab der nächsten Hand
    else if (m.t == 'train' && p) { // The Train live ändern
      const a = m.amt > 0 ? cents(m.amt) : 0; if (T.live) T.trainNext = a; else { T.train = a; if (!a) T.tr = null; }
      ev({ k: 'toast', m: p.name + ': The Train ' + (a ? 'AN (' + (a / 100).toFixed(2).replace('.', ',') + ' € pro Spieler)' : 'AUS') + (T.live ? ' – gilt ab der nächsten Hand' : '') }); bc();
    }
    else if (m.t == 'name' && p) { // Nickname: nur die Anzeige am Tisch, Hauptname (T.nm) + Konto bleiben
      const n = String(m.name || '').trim().slice(0, 14) || T.nm[p.uid]; if (n == p.name) return;
      ev({ k: 'toast', m: p.name + ' heißt jetzt ' + n }); p.name = n; bc();
    }
    else if (m.t == 'av' && p) { // eigenes Profilbild setzen ('' = entfernen); nur kleines JPEG
      const d = m.d === '' ? '' : (String(m.d || '').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/) || [])[1];
      if (d == null || d.length > 60000 || (d && !Buffer.from(d.slice(0, 8), 'base64').subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))) return send(p, { t: 'e', k: 'err', m: 'Bild ungültig oder zu groß.' });
      if (d) L.av[p.uid] = { d, v: Date.now() }; else delete L.av[p.uid]; if (L.md[p.uid]) delete L.md[p.uid].av; save(); bc();
    }
    else if (m.t == 'md' && p) { // GIF-Profilbild, Sieges-Musik, Kill-Sounds #1–#5 ('' = entfernen); Länge ≤ 6 s prüft der Browser, abgespielt wird ohnehin max. 6 s
      const s = ['av', 'w', 'k0', 'k1', 'k2', 'k3', 'k4'].includes(m.s) ? m.s : null; if (!s) return;
      const D = L.md[p.uid] ??= {}, f = `${MDIR}/${p.uid}-${s}`;
      if (m.d === '') { delete D[s]; fs.rmSync(f, { force: true }); }
      else {
        const x = String(m.d || '').match(/^data:[\w/.+-]*;base64,([A-Za-z0-9+/]+={0,2})$/), b = x && Buffer.from(x[1], 'base64'), t = b && mtype(b);
        if (!t || b.length > 1048576 || (s == 'av') != (t == 'image/gif')) return send(p, { t: 'e', k: 'err', m: 'Datei ungültig oder zu groß (max. 1 MB · Profilbild: GIF · Sounds: MP3/WAV).' });
        fs.writeFileSync(f, b); D[s] = { v: Date.now(), m: t }; if (s == 'av') delete L.av[p.uid];
      }
      save(); bc();
    }
    else if (m.t == 'ssx') { // Session-Ende: P/L ins Dashboard (Discord-Webhook) oder Spaßrunde – entscheidet der erste Teilnehmer, nur einmal
      const x = L.ss.find(s => s.id == m.id), say = (k, t) => ws.send(JSON.stringify({ t: 'e', k, m: t }));
      if (!x || x.sx || !x.tx.some(t => t.uid == ws.pu)) return;
      if (!m.sync) { x.sx = 2; save(); return say('toast', 'Session #' + x.id + ': Spaßrunde – nichts übertragen.'); }
      if (!HOOK) return say('err', 'Kein Dashboard-Webhook eingerichtet (DISCORD_WEBHOOK fehlt).');
      x.sx = 1; save(); hook(x).then(() => say('toast', 'Session #' + x.id + ': P/L ins Dashboard übertragen.'), e => { x.sx = 0; save(); say('err', 'Übertragung fehlgeschlagen (' + e.message + ') – im Archiv erneut versuchen.'); });
    }
    else if (m.t == 'addp') { // neuen Hauptnamen dauerhaft anlegen (eindeutig, ohne Groß/Klein)
      const n = String(m.name || '').trim().slice(0, 14);
      if (!n || Object.values(T.nm).some(x => x.toLowerCase() == n.toLowerCase())) return ws.send(JSON.stringify({ t: 'e', k: 'err', m: n ? n + ' gibt es schon.' : 'Bitte einen Namen eingeben.' }));
      T.nm[++T.un] = n; save(); ws.send(JSON.stringify({ t: 'e', k: 'addp', u: T.un })); bc();
    }
    else if (m.t == 'delp') { // Hauptnamen löschen: nur mit Bestätigungswort, nie wenn er am Tisch sitzt
      const u = m.u | 0, n = T.nm[u];
      if (!n) return ws.send(JSON.stringify({ t: 'e', k: 'err', m: 'Spieler nicht gefunden.' }));
      if (m.c !== 'LÖSCHEN' && m.c !== n) return ws.send(JSON.stringify({ t: 'e', k: 'err', m: 'Bestätigung falsch – tippe LÖSCHEN oder den Namen.' }));
      if (T.pl.some(q => q.uid == u)) return ws.send(JSON.stringify({ t: 'e', k: 'err', m: n + ' sitzt am Tisch und kann nicht gelöscht werden.' }));
      L.dn[u] = n; delete T.nm[u]; delete L.av[u]; delete L.md[u]; save(); ws.send(JSON.stringify({ t: 'e', k: 'toast', m: n + ' gelöscht.' })); bc();
    }
    else if (m.t == 'close' && p) closeTable();
    else if (m.t == 'ss') ws.send(JSON.stringify({ t: 'e', k: 'ssl', l: L.ss.slice(-50).map(s => ({ ...s, tx: s.tx.map(t => ({ ...t, name: nm(t.uid) })) })) })); // Archiv: für alle sichtbar
  });
  ws.on('close', () => {
    T.sp.delete(ws); p = ws.P; if (!p) return; // Verbindung weg: Platz + Stack bleiben, nur Aussetzen ab der nächsten Hand – folden nur per Call Clock
    if (!p.so) { p.so = p.dso = 1; if (!T.live) p.ghost = 1; } bpOk(p); bc();
  });
});
srv.listen(process.env.PORT || 3000, () => console.log('Poker-Server auf http://localhost:' + (process.env.PORT || 3000)));
