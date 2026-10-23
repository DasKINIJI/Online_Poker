// Selbsttest (npm test, ~1,5 min): Re-Straddle nach All-in, Live-Voting, Session-Archiv, Deck-SVGs, Match-Stack, Pot/Min-Raise, Reconnect, Löschen.
// Läuft in einer Temp-Kopie – das echte data/ledger.json wird nie angefasst.
const assert = require('assert'), { spawn } = require('child_process'), path = require('path'), fs = require('fs'), os = require('os');
const SRC = __dirname, DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'poker-test-')), PORT = 3917, WS = require('ws');
for (const f of ['server.js', 'index.html']) fs.copyFileSync(path.join(SRC, f), path.join(DIR, f));
fs.cpSync(path.join(SRC, 'cards'), path.join(DIR, 'cards'), { recursive: true });
const srv = spawn(process.execPath, ['server.js'], { cwd: DIR, env: { ...process.env, PORT, NODE_PATH: path.join(SRC, 'node_modules') } });
srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function client(name) {
  const ws = new WS('ws://localhost:' + PORT), c = { ws, s: null, ev: [], send: o => ws.send(JSON.stringify(o)) };
  ws.on('message', d => { const m = JSON.parse(d); if (m.t == 's') c.s = m; else c.ev.push(m); });
  return new Promise(r => ws.on('open', () => r(c)));
}
const until = async (f, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout: ' + f); await sleep(30); } };
(async () => {
  await sleep(600);
  // Deck-SVGs
  for (const [u, must] of [['/cards/full/QH.svg', 'fill="#c8202c"'], ['/cards/gold/KS.svg', 'url(#gd)'], ['/cards/2color/AS.svg', 'fill="white"'], ['/cards/4color/2C.svg', 'green']]) {
    const r = await fetch('http://localhost:' + PORT + u), t = await r.text();
    assert.equal(r.headers.get('content-type'), 'image/svg+xml', u); assert(t.includes(must), u + ' enthält ' + must);
  }
  const full = await (await fetch('http://localhost:' + PORT + '/cards/full/3D.svg')).text();
  assert(!/<symbol id="[SV]D3"[^]*?(fill|stroke)="(red|blue)"/.test(full), 'Vollfarbig: Index/Pips weiß');
  assert.equal((await fetch('http://localhost:' + PORT + '/cards/full/../server.js')).headers.get('content-type'), 'text/html;charset=utf-8', 'kein Pfad-Trick');

  // Re-Straddle: A straddelt all-in mit 100 BB, B (150 BB) re-straddelt all-in, C kann Blind Call
  const A = await client(), B = await client(), C = await client();
  // Spielerliste: Hauptnamen anlegen (eindeutig), Buy-in nur per Auswahl
  for (const n of ['Anna', 'Ben', 'Cem']) { A.ev = []; A.send({ t: 'addp', name: n }); await until(() => A.ev.some(e => e.k == 'addp')); }
  A.ev = []; A.send({ t: 'addp', name: 'anna' }); await until(() => A.ev.some(e => e.k == 'err')); // doppelt -> abgelehnt
  await until(() => A.s && A.s.mp.length == 3); const U = Object.fromEntries(A.s.mp.map(x => [x.n, x.u]));
  A.send({ t: 'join', uid: U.Anna, buyin: 10 }); await until(() => A.s && A.s.me >= 0);
  await until(() => B.s && B.s.mp.find(x => x.u == U.Anna).b == 1, 2000); // Anna für andere ausgegraut
  B.ev = []; B.send({ t: 'join', uid: U.Anna, buyin: 10 }); await until(() => B.ev.some(e => e.k == 'err')); assert(B.s.me < 0, 'belegter Hauptname nicht wählbar');
  // Profilbild: nur JPEG, wird per /av/<uid>.jpg ausgeliefert
  A.ev = []; A.send({ t: 'av', d: 'data:image/png;base64,iVBORw0KGgo=' }); await until(() => A.ev.some(e => e.k == 'err'));
  A.send({ t: 'av', d: 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]).toString('base64') }); await until(() => A.s.mp.find(x => x.u == U.Anna).a > 0);
  const ar = await fetch('http://localhost:' + PORT + '/av/' + U.Anna + '.jpg'); assert.equal(ar.headers.get('content-type'), 'image/jpeg'); assert.equal((await ar.arrayBuffer()).byteLength, 6);
  A.send({ t: 'name', name: 'Annie' }); await until(() => A.s.pl[A.s.me].name == 'Annie'); assert.equal(A.s.mn, 'Anna', 'Nickname ändert Hauptnamen nicht');
  A.send({ t: 'deduct', amt: 5 }); await until(() => A.s.pl[A.s.me].stack == 500); // A: 50 BB
  A.send({ t: 'straddle', amt: 1000 }); // -> all-in mit 50 BB (BB = 10 ct)
  B.ev = []; B.send({ t: 'join', uid: U.Ben, buyin: 15 }); await until(() => B.ev.some(e => e.k == 'err')); assert(B.s.me < 0, 'Späteinsteiger max. Match Stack (100 BB)');
  B.send({ t: 'join', uid: U.Ben, buyin: 10 }); C.send({ t: 'join', uid: U.Cem, buyin: 10 });
  await until(() => B.s.me >= 0 && C.s.me >= 0 && A.s.rd); await sleep(1500);
  assert(!A.s.live && A.s.rd, 'erste Hand wartet auf Bereit');
  A.send({ t: 'rdy', on: 1 }); B.send({ t: 'rdy', on: 1 }); await until(() => A.s.pl.filter(q => q.rdy).length == 2); await sleep(1200);
  assert(!A.s.live, 'startet nicht, solange einer nicht bereit ist');
  C.send({ t: 'rdy', on: 1 });
  await until(() => A.s.sdp > 0, 10000);
  console.log('✓ Bereit-Runde vor der ersten Hand');
  const ia = A.s.me, ib = B.s.me, ic = C.s.me;
  assert.equal(A.s.pl[ia].sg, 500, 'A-Straddle 50 BB'); assert(A.s.pl[ia].allin, 'A ist all-in');
  assert(B.s.sde.includes(ib), 'B darf re-straddeln');
  B.send({ t: 'rs', amt: 1000 }); await until(() => B.s.cur == 1000);
  assert(B.s.pl[ib].allin && B.s.pl[ib].sg == 1000, 'B re-straddelt all-in 100 BB');
  assert.equal(C.s.sai, 1, 'Blind Call gegen All-in-Straddle möglich');
  C.send({ t: 'bcall', on: 1 }); await until(() => C.s.pl[ic].bcall == 1);
  // nach der Phase: großes Schild weg -> sg bleibt als Badge-Info, sdp = 0
  await until(() => A.s.sdp <= 0 && A.s.pl.every(q => q.in), 14000);
  assert.equal(A.s.pl[ib].sg, 1000, 'Straddle-Info bleibt für das Badge');
  // C callt blind mit 100 BB -> alle all-in -> Abstimmung
  await until(() => A.s.vt > 0, 6000);
  assert.deepEqual(A.s.pl.map(q => q.vt), [0, 0, 0], 'alle „Wartet…“');
  A.send({ t: 'vote', n: 2 }); await until(() => C.s.pl[ia].vt == 2);
  assert.equal(C.s.pl[ib].vt, 0, 'B wartet noch'); // Live-Broadcast an alle
  B.send({ t: 'vote', n: 3 }); await until(() => A.s.pl[ib].vt == 3);
  C.send({ t: 'vote', n: 2 }); await until(() => A.s.vt <= 0 && A.s.pl.every(q => q.vt == -1));
  console.log('✓ Re-Straddle all-in, Blind Call, Live-Voting');

  // Session: Tisch schließen -> abgehakt, neue Session beginnt leer
  await until(() => !A.s.live, 60000);
  A.send({ t: 'close' }); await until(() => A.s.me < 0 && B.s.me < 0);
  A.ev = []; A.send({ t: 'ss' }); await until(() => A.ev.some(e => e.k == 'ssl'));
  const ss = A.ev.find(e => e.k == 'ssl').l; assert.equal(ss.length, 1);
  assert(ss[0].tx.every(t => t.name != 'Annie'), 'Transaktionen laufen auf den Hauptnamen');
  const bi = ss[0].tx.filter(t => /Buy/.test(t.type)).reduce((a, t) => a + t.amt, 0), out = ss[0].tx.filter(t => t.type == 'Auszahlung').reduce((a, t) => a + t.amt, 0);
  assert.equal(bi, 3000); assert.equal(out, 2500, 'Geld bleibt erhalten (3000 Buy-in − 500 Korrektur)');
  await sleep(7200); // Lock nach dem Schließen
  const PA = 'a'.repeat(32);
  A.send({ t: 'join', uid: U.Anna, buyin: 20, pid: PA }); await until(() => A.s.me >= 0);
  A.ev = []; A.send({ t: 'tx' }); await until(() => A.ev.some(e => e.k == 'txl'));
  assert.deepEqual(A.ev.find(e => e.k == 'txl').l.map(t => t.amt), [2000], 'frische Session');
  // Pot ohne laufende Einsätze + Min-Raise 2x (Heads-up, BB = 40 ct)
  B.send({ t: 'join', uid: U.Ben, buyin: 20 }); await until(() => B.s.me >= 0 && A.s.pl.length == 2);
  A.send({ t: 'rdy', on: 1 }); await until(() => A.s.pl.some(q => q.rdy)); B.send({ t: 'rdy', on: 1, go: 1 }); // Trotzdem starten (hier ohnehin alle bereit)
  await until(() => A.s.live && A.s.turn >= 0 && A.s.pl.every(q => q.in), 10000);
  assert.equal(A.s.pot, 0, 'Blinds liegen vor den Spielern, noch nicht im Pot');
  const P0 = [A, B].find(c => c.s.turn == c.s.me), cur = P0.s.cur;
  P0.send({ t: 'act', a: 'raise', amt: cur * 2 - 5 }); await sleep(300); assert.equal(P0.s.cur, cur, 'Raise unter 2x abgelehnt');
  P0.send({ t: 'act', a: 'raise', amt: cur * 2 }); await until(() => P0.s.cur == cur * 2);
  const P1 = P0 == A ? B : A; await until(() => P1.s.turn == P1.s.me); P1.send({ t: 'act', a: 'call' });
  await until(() => A.s.board.length == 3, 5000); assert.equal(A.s.pot, cur * 4, 'Einsätze nach der Runde eingesammelt');
  // Verbindungsabbruch: kein Kick, nur Aussetzen; Reconnect per pid übernimmt den Platz
  A.ws.close(); await until(() => B.s.pl.find(q => q.u == U.Anna).so == 1);
  const A2 = await client(); A2.send({ t: 're', pid: PA }); await until(() => A2.s && A2.s.me >= 0);
  assert.equal(A2.s.pl[A2.s.me].so, 0, 'nach Reconnect wieder aktiv');
  const P2 = [A2, B].find(c => c.s.turn == c.s.me); P2.send({ t: 'act', a: 'fold' });
  A2.send({ t: 'cash' }); B.send({ t: 'cash' }); await until(() => A2.s.me < 0 && B.s.me < 0, 12000); // letzte verlassen den Tisch -> Session 2 abgehakt
  B.ev = []; B.send({ t: 'ss' }); await until(() => B.ev.some(e => e.k == 'ssl'));
  assert.equal(B.ev.find(e => e.k == 'ssl').l.length, 2, 'leerer Tisch hakt ab');
  const L = JSON.parse(fs.readFileSync(path.join(DIR, 'data/ledger.json'), 'utf8')); assert.equal(L.tx.length, 0); assert.equal(L.ss.length, 2);
  console.log('✓ Session-Archiv, Match-Stack, Pot/Min-Raise, Reconnect');
  // Hauptnamen löschen: nur mit Bestätigungswort, Historie behält den Namen
  B.ev = []; B.send({ t: 'delp', u: U.Cem, c: 'ja' }); await until(() => B.ev.some(e => e.k == 'err'));
  B.send({ t: 'delp', u: U.Cem, c: 'LÖSCHEN' }); await until(() => !B.s.mp.some(x => x.u == U.Cem));
  B.ev = []; B.send({ t: 'ss' }); await until(() => B.ev.some(e => e.k == 'ssl'));
  assert(B.ev.find(e => e.k == 'ssl').l[0].tx.some(t => t.name == 'Cem'), 'gelöschter Name bleibt im Archiv');
  console.log('✓ Hauptname löschen');
  srv.kill(); fs.rmSync(DIR, { recursive: true, force: true }); process.exit(0);
})().catch(e => { console.error('FAIL', e); srv.kill(); process.exit(1); });
