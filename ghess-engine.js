// Ghess — rules engine and computer player. Loaded by ghess.html on the page and again inside a Web Worker.
// Ordinary chess on a 10×10 board with a camel and a commoner (Mann) among the pieces: R N C B Q K B M N R, always shuffled
// 960-style, pawns in front. The pawn in front of the camel is a giraffe pawn: it promotes only to a giraffe (Timur's giraffe move
// plus the camel's leap). Behind each king sits a citadel square; the enemy king wins by stepping into it.
// Plus two house rules: the shah's privilege (once a game, a checked king may swap places with one of its pieces, not a pawn) and the griffin
// (one per side, off the board; from move 25 it may swoop onto an enemy pawn and kill it, stays for two of its owner's moves —
// moving and capturing one square diagonally — then flies away. If it is killed, the pawn comes back on that square once the
// piece that killed it moves away).
"use strict";
// ===================== engine =====================
// Squares 0..99: index = rank*10 + file, a1 = 0, j10 = 99. 100 = White's citadel (behind White's king), 101 = Black's.
const CIT_W = 100, CIT_B = 101, NSQ = 102;
const FILES = "abcdefghij";
const NAME = { K: "king", Q: "queen", R: "rook", B: "bishop", N: "knight", C: "camel", M: "commoner", Z: "giraffe", G: "griffin", p: "pawn" };
const SWOOP_PLY = 48;   // the griffin may come in once both sides have made twenty-four moves
const HAND = -1;        // m.f of a griffin drop
const LIFE = 2;         // the griffin stays for this many of its owner's moves after the swoop
const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]], DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const KN = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
const CAM = [[1, 3], [3, 1], [-1, 3], [-3, 1], [1, -3], [3, -1], [-1, -3], [-3, -1]];
const sq = (x, y) => (x >= 0 && x < 10 && y >= 0 && y < 10) ? y * 10 + x : -1;
const xy = i => [i % 10, Math.floor(i / 10)];
const sqName = i => i >= 100 ? "citadel" : FILES[i % 10] + (Math.floor(i / 10) + 1);
const kingFile = setup => setup.indexOf("K");
const enemyCit = c => c === 0 ? CIT_B : CIT_W;
const fwd = c => c === 0 ? 1 : -1, lastRank = c => c === 0 ? 9 : 0, homeRank = c => c === 0 ? 0 : 9, pawnRank = c => c === 0 ? 1 : 8;
const PROMO = ["Q", "R", "B", "N"];
const CLASSIC = "RNCBQKBMNR";   // the unshuffled army; games are always dealt 960-style from it
// castling: the king lands on c/i (file 2/8), the rook beside it on d/h (file 3/7) — the Capablanca / Chess960 convention, whatever the setup
const KDEST = [2, 8], RDEST = [3, 7];

// 960-style setups: a seeded shuffle of the ten back-rank pieces with the bishops on opposite colours and the king between the rooks.
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function setupFor(seed) {
  if (!seed) return CLASSIC;
  const rnd = mulberry32(seed), arr = CLASSIC.split("");
  for (; ;) {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    const b = [], r = []; let k = -1;
    arr.forEach((t, i) => { if (t === "B") b.push(i); if (t === "R") r.push(i); if (t === "K") k = i; });
    if ((b[0] + b[1]) % 2 === 1 && k > r[0] && k < r[1]) return arr.join("");
  }
}
function rookFiles(setup) { const r = []; for (let i = 0; i < 10; i++) if (setup[i] === "R") r.push(i); return r; }   // [queenside, kingside]
function initialBoard(setup = CLASSIC) {
  const b = new Array(NSQ).fill(null);
  for (let x = 0; x < 10; x++) {
    const t = setup[x], pt = t === "C" ? "z" : "p";
    b[sq(x, 0)] = { c: 0, t }; b[sq(x, 9)] = { c: 1, t };
    b[sq(x, 1)] = { c: 0, t: "p", pt }; b[sq(x, 8)] = { c: 1, t: "p", pt };
  }
  return b;
}
function newState(setup = CLASSIC) { return { b: initialBoard(setup), turn: 0, cr: [[true, true], [true, true]], ep: -1, half: 0, swap: [false, false], hand: [true, true], ply: 0, rest: [], over: null, last: null, setup }; }
// board tokens: wK, bpc (camel pawn), wGc2 (griffin that killed a camel pawn, two moves of life left)
function pack(b) { return b.map(p => p ? (p.c ? "b" : "w") + p.t + (p.t === "p" ? p.pt : p.t === "G" ? p.v + p.life : "") : ".").join(" "); }
function unpack(s) { const b = s.split(" ").map(t => { if (t === ".") return null; const p = { c: t[0] === "b" ? 1 : 0, t: t[1] }; if (p.t === "p") p.pt = t[2] || "p"; if (p.t === "G") { p.v = t[2] || "p"; p.life = +t[3] || 0; } return p; }); while (b.length < NSQ) b.push(null); return b; }
// rest: pawns waiting to come back — [square, colour, pawn type] — placed as soon as the square empties
const cloneRest = r => r.map(x => x.slice());
function kingSq(b, c) { for (let i = 0; i < 100; i++) { const p = b[i]; if (p && p.c === c && p.t === "K") return i; } return -1; }

function ray(b, x, y, dx, dy, fn) {   // fn(j, piece) → false to stop
  let cx = x, cy = y;
  for (; ;) { cx += dx; cy += dy; const j = sq(cx, cy); if (j < 0) return; const q = b[j]; if (fn(j, q) === false) return; if (q) return; }
}
function giraffeTargets(b, i) {   // Timur's giraffe: one diagonal step (empty), then at least three squares straight on outward, nothing in the way
  const out = [], [x, y] = xy(i);
  for (const [dx, dy] of DIAG) {
    const s1 = sq(x + dx, y + dy); if (s1 < 0 || b[s1]) continue;
    for (const [ex, ey] of [[dx, 0], [0, dy]]) {
      let cx = x + dx, cy = y + dy, ok = true;
      for (let k = 1; k <= 2; k++) { cx += ex; cy += ey; const j = sq(cx, cy); if (j < 0 || b[j]) { ok = false; break; } }
      if (!ok) continue;
      for (; ;) { cx += ex; cy += ey; const j = sq(cx, cy); if (j < 0) break; out.push(j); if (b[j]) break; }
    }
  }
  return out;
}
function attacked(b, i, by) {   // is square i attacked by colour `by`?
  if (i >= 100) return false;
  const [x, y] = xy(i);
  const has = (j, ts) => { if (j < 0) return false; const q = b[j]; return !!(q && q.c === by && ts.includes(q.t)); };
  for (const [dx, dy] of DIRS8) if (has(sq(x + dx, y + dy), "KM")) return true;
  for (const [dx, dy] of KN) if (has(sq(x + dx, y + dy), "N")) return true;
  for (const [dx, dy] of CAM) if (has(sq(x + dx, y + dy), "C")) return true;
  const f = fwd(by);
  for (const dx of [-1, 1]) { const j = sq(x + dx, y - f); const q = j >= 0 && b[j]; if (q && q.c === by && q.t === "p") return true; }
  let hit = false;
  for (const [dx, dy] of ORTH) { ray(b, x, y, dx, dy, (j, q) => { if (q && q.c === by && (q.t === "R" || q.t === "Q")) hit = true; }); if (hit) return true; }
  for (const [dx, dy] of DIAG) { ray(b, x, y, dx, dy, (j, q) => { if (q && q.c === by && (q.t === "B" || q.t === "Q")) hit = true; }); if (hit) return true; }
  for (const [dx, dy] of DIAG) if (has(sq(x + dx, y + dy), "G")) return true;
  // giraffe: the camel leap, or walk back ≥3 straight squares (all empty) then one diagonal step back — that square empty too
  for (const [dx, dy] of CAM) if (has(sq(x + dx, y + dy), "Z")) return true;
  for (const [ex, ey] of ORTH) {
    let cx = x, cy = y;
    for (let k = 1; ; k++) {
      cx -= ex; cy -= ey; const j = sq(cx, cy); if (j < 0 || b[j]) break;
      if (k < 3) continue;
      for (const perp of [-1, 1]) { const gx = ex ? cx - ex : cx - perp, gy = ey ? cy - ey : cy - perp; if (has(sq(gx, gy), "Z")) return true; }
    }
  }
  return false;
}
// pseudo-legal moves of the piece on i. kinds: (none) plain, "e" en passant, "c" castling (t = the rook's square), "s" king swap,
// "g" griffin swoop, "w" king into the enemy citadel (wins), pr = promotion piece
function pieceMoves(st, i, out) {
  const b = st.b, p = b[i], c = p.c, [x, y] = xy(i);
  const add = (j, extra) => out.push(Object.assign({ f: i, t: j }, extra || {}));
  const step = j => { if (j < 0) return; const q = b[j]; if (!q || q.c !== c) add(j); };
  const slide = dirs => { for (const [dx, dy] of dirs) ray(b, x, y, dx, dy, (j, q) => { if (!q || q.c !== c) add(j); }); };
  switch (p.t) {
    case "K": {
      for (const [dx, dy] of DIRS8) step(sq(x + dx, y + dy));
      { const kf = kingFile(st.setup), cy = c === 0 ? 10 : -1; if (Math.abs(x - kf) <= 1 && y + (c === 0 ? 1 : -1) === cy) add(enemyCit(c), { k: "w" }); }
      if (!st.swap[c] && attacked(b, i, 1 - c)) {   // the shah's privilege: trade places with any other piece of yours — pieces only, not pawns
        for (let j = 0; j < 100; j++) { const q = b[j]; if (!q || q.c !== c || q.t === "K" || q.t === "p") continue; add(j, { k: "s" }); }
      }
      if (y === homeRank(c)) {
        const rf = rookFiles(st.setup);
        for (const side of [0, 1]) {
          if (!st.cr[c][side]) continue;
          const rx = rf[side], rsq = sq(rx, y), r = b[rsq]; if (!r || r.c !== c || r.t !== "R") continue;
          const kd = KDEST[side], rd = RDEST[side];
          const lo = Math.min(x, rx, kd, rd), hi = Math.max(x, rx, kd, rd); let ok = true;
          for (let fx = lo; fx <= hi && ok; fx++) { if (fx === x || fx === rx) continue; if (b[sq(fx, y)]) ok = false; }
          if (!ok) continue;
          const s = Math.sign(kd - x) || 1;
          for (let fx = x; ok; fx += s) { if (attacked(b, sq(fx, y), 1 - c)) ok = false; if (fx === kd) break; }
          if (ok) add(rsq, { k: "c" });
        }
      }
      break;
    }
    case "Q": slide(ORTH); slide(DIAG); break;
    case "R": slide(ORTH); break;
    case "B": slide(DIAG); break;
    case "N": for (const [dx, dy] of KN) step(sq(x + dx, y + dy)); break;
    case "C": for (const [dx, dy] of CAM) step(sq(x + dx, y + dy)); break;
    case "M": for (const [dx, dy] of DIRS8) step(sq(x + dx, y + dy)); break;
    case "Z": for (const [dx, dy] of CAM) step(sq(x + dx, y + dy)); for (const j of giraffeTargets(b, i)) step(j); break;
    case "G": for (const [dx, dy] of DIAG) step(sq(x + dx, y + dy)); break;
    case "p": {
      const f = fwd(c), ty = y + f, last = ty === lastRank(c);
      const prs = last ? (p.pt === "z" ? ["Z"] : PROMO) : [null];
      const addP = (j, extra) => { for (const pr of prs) add(j, pr ? Object.assign({ pr }, extra || {}) : extra); };
      const j = sq(x, ty);
      if (j >= 0 && !b[j]) { addP(j); if (y === pawnRank(c)) { const j2 = sq(x, ty + f); if (j2 >= 0 && !b[j2]) add(j2); } }
      for (const dx of [-1, 1]) { const k = sq(x + dx, ty); if (k < 0) continue; const q = b[k]; if (q && q.c !== c) addP(k); else if (!q && k === st.ep) add(k, { k: "e" }); }
      break;
    }
  }
}
function gen(st, c = st.turn) {
  const out = []; for (let i = 0; i < 100; i++) { const p = st.b[i]; if (p && p.c === c) pieceMoves(st, i, out); }
  if (st.hand[c] && st.ply >= SWOOP_PLY) for (let i = 0; i < 100; i++) { const p = st.b[i]; if (p && p.c !== c && p.t === "p") out.push({ f: HAND, t: i, k: "g" }); }
  return out;
}
function make(st, m) {
  const b = st.b, u = { ch: [], turn: st.turn, cr: [st.cr[0].slice(), st.cr[1].slice()], ep: st.ep, half: st.half, swap: st.swap.slice(), hand: st.hand.slice(), ply: st.ply, rest: cloneRest(st.rest), over: st.over, last: st.last };
  const set = (i, p) => { u.ch.push([i, b[i]]); b[i] = p; };
  const c = st.turn, p = m.f === HAND ? { c, t: "G", v: b[m.t].pt, life: LIFE } : b[m.f], q = b[m.t], rf = rookFiles(st.setup);
  st.ep = -1; st.half++; st.ply++;
  if (q && q.t === "G" && m.k !== "s") st.rest = st.rest.concat([[m.t, q.c === 0 ? 1 : 0, q.v]]);   // a killed griffin: its victim waits under the killer
  if (m.k === "g") { set(m.t, p); st.hand[c] = false; st.half = 0; }
  else if (m.k === "w") { set(m.f, null); set(m.t, p); st.over = { result: c === 0 ? "w" : "b", why: "the king reached the citadel" }; }
  else if (m.k === "s") { set(m.t, p); set(m.f, q); st.swap[c] = true; st.cr[c] = [false, false]; }
  else if (m.k === "c") {
    const side = m.t === sq(rf[1], homeRank(c)) ? 1 : 0, y = homeRank(c);
    set(m.f, null); set(m.t, null); set(sq(KDEST[side], y), p); set(sq(RDEST[side], y), q);
    st.cr[c] = [false, false];
  } else {
    set(m.f, null);
    if (m.k === "e") set(sq(m.t % 10, xy(m.f)[1]), null);
    set(m.t, m.pr ? { c, t: m.pr } : p);
    if (p.t === "p") { st.half = 0; if (Math.abs(xy(m.t)[1] - xy(m.f)[1]) === 2) st.ep = sq(m.f % 10, xy(m.f)[1] + fwd(c)); }
    if (q) st.half = 0;
    if (p.t === "K") st.cr[c] = [false, false];
    if (p.t === "R" && xy(m.f)[1] === homeRank(c)) { const fx = m.f % 10; if (fx === rf[0]) st.cr[c][0] = false; if (fx === rf[1]) st.cr[c][1] = false; }
    if (q && q.t === "R" && xy(m.t)[1] === homeRank(q.c)) { const fx = m.t % 10; if (fx === rf[0]) st.cr[q.c][0] = false; if (fx === rf[1]) st.cr[q.c][1] = false; }
  }
  // the mover's griffin, if it was already on the board, uses up a move of its stay and flies away when none is left
  if (m.k !== "g") for (let i = 0; i < 100; i++) { const g = b[i]; if (g && g.c === c && g.t === "G") { if (g.life <= 1) set(i, null); else set(i, { c, t: "G", v: g.v, life: g.life - 1 }); break; } }
  // pawns waiting to come back do so as soon as their square is empty (not onto their last rank — then they stay gone)
  if (st.rest.length) { const keep = []; for (const r of st.rest) { if (!b[r[0]]) { if (xy(r[0])[1] !== lastRank(r[1])) set(r[0], { c: r[1], t: "p", pt: r[2] }); } else keep.push(r); } st.rest = keep; }
  st.last = [m.f, m.t]; st.turn = 1 - c; return u;
}
function unmake(st, u) { for (let k = u.ch.length - 1; k >= 0; k--) st.b[u.ch[k][0]] = u.ch[k][1]; st.turn = u.turn; st.cr = u.cr; st.ep = u.ep; st.half = u.half; st.swap = u.swap; st.hand = u.hand; st.ply = u.ply; st.rest = u.rest; st.over = u.over; st.last = u.last; }
function inCheck(st, c) { const k = kingSq(st.b, c); return k >= 0 && attacked(st.b, k, 1 - c); }
function legal(st) {
  const c = st.turn, out = [];
  for (const m of gen(st, c)) { const u = make(st, m); const bad = !st.over && inCheck(st, c); unmake(st, u); if (!bad) out.push(m); }
  return out;
}
function bare(st) { if (st.hand[0] || st.hand[1] || st.rest.length) return false; for (let i = 0; i < 100; i++) { const p = st.b[i]; if (p && p.t !== "K") return false; } return true; }
function status(st) {   // null while the game goes on
  if (st.over) return st.over;
  const c = st.turn, other = c ? "w" : "b";
  if (!legal(st).length) return inCheck(st, c) ? { result: other, why: "checkmate" } : { result: "d", why: "stalemate" };
  if (bare(st)) return { result: "d", why: "only the kings are left" };
  if (st.half >= 100) return { result: "d", why: "fifty moves without a capture or a pawn move" };
  return null;
}
function sameMove(a, b) { return a.f === b.f && a.t === b.t && (a.k || "") === (b.k || "") && (a.pr || "") === (b.pr || ""); }
function notation(st, m) {
  const b = st.b, q = b[m.t];
  if (m.k === "g") return "G↓" + sqName(m.t) + "×";
  const p = b[m.f];
  if (m.k === "s") return "K⇄" + (q.t === "p" ? "p" : q.t) + " " + sqName(m.t);
  if (m.k === "w") return "K" + sqName(m.f) + "→citadel";
  if (m.k === "c") return m.t % 10 > m.f % 10 ? "O-O" : "O-O-O";
  let s = p.t === "p" ? "" : p.t;
  s += sqName(m.f) + (q || m.k === "e" ? "×" : "–") + sqName(m.t);
  if (m.pr) s += "=" + m.pr;
  return s;
}

// ---------- the computer: alpha-beta over legal moves, captures-only quiescence, iterative deepening on a time budget ----------
const VAL = { K: 0, Q: 9.5, R: 5.2, B: 3.4, N: 3, M: 3, C: 2.2, Z: 4.5, G: 1.3, p: 1 };
const HAND_VAL = 1.1;   // a griffin still in hand: a pawn to be taken, give or take
function evaluate(st) {
  const b = st.b; let s = 0; const mat = [0, 0], ksq = [-1, -1];
  for (let i = 0; i < 100; i++) {
    const p = b[i]; if (!p) continue; let v = VAL[p.t]; const x = i % 10, y = Math.floor(i / 10);
    if (p.t === "K") ksq[p.c] = i; else if (p.t !== "p") mat[p.c] += v;
    if (p.t === "p") { const adv = p.c === 0 ? y - 1 : 8 - y; v += adv * adv * 0.03 + (p.pt === "z" ? 0.05 : 0); }
    else if (p.t === "N" || p.t === "C" || p.t === "B" || p.t === "M") v += 0.25 - 0.05 * (Math.abs(x - 4.5) + Math.abs(y - 4.5)) / 2;   // minor pieces like the middle of a big board
    else if (p.t === "R" || p.t === "Q") v += y === homeRank(p.c) ? 0 : 0.05;
    s += p.c === 0 ? v : -v;
  }
  for (const c of [0, 1]) if (st.hand[c]) { mat[c] += HAND_VAL; s += c === 0 ? HAND_VAL : -HAND_VAL; }
  for (const r of st.rest) s += r[1] === 0 ? 0.85 : -0.85;
  // endgame: when a side has little left, the other side scores for cornering its king and bringing its own king close
  for (const c of [0, 1]) {
    if (mat[c] > 8 || ksq[c] < 0 || ksq[1 - c] < 0 || mat[1 - c] < 3) continue;
    const [kx, ky] = xy(ksq[c]), [ox, oy] = xy(ksq[1 - c]);
    const edge = Math.max(Math.abs(kx - 4.5), Math.abs(ky - 4.5)), dist = Math.max(Math.abs(kx - ox), Math.abs(ky - oy));
    const bonus = edge * 0.12 + (10 - dist) * 0.06;
    s += c === 0 ? -bonus : bonus;
  }
  // a little king safety while the queens are on: pawns in front of a castled king
  for (const c of [0, 1]) {
    if (ksq[c] < 0 || mat[1 - c] < 12) continue;
    const [kx, ky] = xy(ksq[c]); let shield = 0;
    for (const dx of [-1, 0, 1]) { const j = sq(kx + dx, ky + fwd(c)); const q = j >= 0 && b[j]; if (q && q.c === c && q.t === "p") shield++; }
    const bonus = shield * 0.12 - (ky !== homeRank(c) ? 0.3 : 0);
    s += c === 0 ? bonus : -bonus;
  }
  return st.turn === 0 ? s : -s;
}
let nodes = 0, deadline = 0, aborted = false;
const MATE = 1000;
let killers = [], history = {};
const ZOB = [], ZCODE = new Map(); let zrng = 0x9E3779B9;
const zr = () => { zrng ^= zrng << 13; zrng ^= zrng >>> 17; zrng ^= zrng << 5; return zrng >>> 0; };
for (let i = 0; i < 100; i++) ZOB.push([]);
const ZTURN = [zr(), zr()], ZCR = [[[zr(), zr()], [zr(), zr()]], [[zr(), zr()], [zr(), zr()]]], ZEP = []; for (let i = 0; i < 101; i++) ZEP.push(zr());
const ZSWAP = [[zr(), zr()], [zr(), zr()]], ZHAND = [[zr(), zr()], [zr(), zr()]], ZPLY = [zr(), zr()], ZREST = []; for (let i = 0; i < 200; i++) ZREST.push(zr());
function zcode(p) { const k = p.c + p.t + (p.t === "p" ? p.pt : p.t === "G" ? p.v + p.life : ""); let c = ZCODE.get(k); if (c === undefined) { c = ZCODE.size; ZCODE.set(k, c); } return c; }
function zkey(st) {
  let h1 = 0, h2 = 0x85EBCA6B;
  for (let i = 0; i < 100; i++) { const p = st.b[i]; if (!p) continue; const c = zcode(p); const row = ZOB[i]; while (row.length < 2 * (c + 1)) row.push(zr(), zr()); h1 ^= row[c * 2]; h2 ^= row[c * 2 + 1]; }
  h1 ^= ZTURN[st.turn] ^ ZEP[st.ep + 1] ^ ZPLY[st.ply >= SWOOP_PLY ? 1 : 0]; for (const c of [0, 1]) { for (const s of [0, 1]) h2 ^= ZCR[c][s][st.cr[c][s] ? 1 : 0]; h2 ^= ZSWAP[c][st.swap[c] ? 1 : 0] ^ ZHAND[c][st.hand[c] ? 1 : 0]; }
  for (const r of st.rest) h1 ^= ZREST[r[0] * 2 + r[1]];
  return h1 * 2097152 + (h2 >>> 11);
}
let TT = new Map(); const TT_MAX = 400000;
const mkey = m => (m.f + 1) * 100 + m.t;
function orderMoves(st, ms, ply, pv) {
  const b = st.b, k = killers[ply] || [];
  return ms.map(m => {
    const q = b[m.t]; let sc = 0;
    if (pv && sameMove(m, pv)) sc = 1e6;
    else if (m.k === "g") sc = 11000;
    else if (m.k === "s") sc = 7000;
    else if (q && m.k !== "c") sc = 10000 + VAL[q.t] * 100 - VAL[b[m.f].t];
    else if (m.k === "e") sc = 10000 + 100;
    else if (k[0] && sameMove(k[0], m)) sc = 9000; else if (k[1] && sameMove(k[1], m)) sc = 8000;
    else sc = history[mkey(m)] || 0;
    if (m.pr) sc += 5000 + VAL[m.pr] * 10;
    return [sc, m];
  }).sort((a, c) => c[0] - a[0]).map(x => x[1]);
}
function tryMove(st, m) { const c = st.turn, u = make(st, m); if (!st.over && inCheck(st, c)) { unmake(st, u); return null; } return u; }
function quiesce(st, alpha, beta, d, ply) {
  nodes++; if (st.over) return -(MATE + 50 - ply);
  const c = st.turn, check = inCheck(st, c);
  if (check && d > -3) {
    let any = false, best = -Infinity;
    for (const m of orderMoves(st, gen(st, c), ply)) { const u = tryMove(st, m); if (!u) continue; any = true; const v = -quiesce(st, -beta, -alpha, d - 1, ply + 1); unmake(st, u); if (v > best) best = v; if (v > alpha) alpha = v; if (alpha >= beta) break; }
    return any ? best : -(MATE + 50 - ply);
  }
  const stand = evaluate(st); if (stand >= beta || d <= 0) return stand; if (stand > alpha) alpha = stand;
  let best = stand;
  const ms = orderMoves(st, gen(st, c).filter(m => (st.b[m.t] && m.k !== "c" && m.k !== "s") || m.k === "e" || m.pr === "Q"), ply);
  for (const m of ms) { const u = tryMove(st, m); if (!u) continue; const v = -quiesce(st, -beta, -alpha, d - 1, ply + 1); unmake(st, u); if (v > best) best = v; if (v >= beta) return v; if (v > alpha) alpha = v; }
  return best;
}
function search(st, depth, alpha, beta, ply, ext) {
  nodes++; if ((nodes & 1023) === 0 && performance.now() > deadline) aborted = true;
  if (st.over) return -(MATE + 50 - ply);
  if (depth <= 0) return quiesce(st, alpha, beta, 3, ply);
  const key = zkey(st), tt = TT.get(key), alpha0 = alpha;
  if (tt && tt.depth >= depth) { if (tt.flag === 0) return tt.v; if (tt.flag === 1 && tt.v >= beta) return tt.v; if (tt.flag === 2 && tt.v <= alpha) return tt.v; }
  const c = st.turn; let any = false, best = -Infinity, bestM = null;
  for (const m of orderMoves(st, gen(st, c), ply, tt && tt.m)) {
    const u = tryMove(st, m); if (!u) continue; any = true;
    const givesCheck = !st.over && inCheck(st, st.turn);
    const e = givesCheck && ext < 3 ? 1 : 0;
    const v = -search(st, depth - 1 + e, -beta, -alpha, ply + 1, ext + e); unmake(st, u);
    if (aborted) return best;
    if (v > best) { best = v; bestM = m; }
    if (v > alpha) alpha = v;
    if (alpha >= beta) { if (!st.b[m.t] || m.k === "s") { const k = killers[ply] || (killers[ply] = []); if (!k[0] || !sameMove(k[0], m)) { k[1] = k[0]; k[0] = m; } history[mkey(m)] = (history[mkey(m)] || 0) + depth * depth; } break; }
  }
  if (!any) return inCheck(st, c) ? -(MATE + 50 - ply) : 0;   // mated, or stalemated (a draw)
  if (!aborted) { if (TT.size > TT_MAX) TT.clear(); TT.set(key, { depth, v: best, flag: best <= alpha0 ? 2 : best >= beta ? 1 : 0, m: bestM }); }
  return best;
}
function searchRoot(st, ms, budget, maxD) {   // iterative deepening over the root moves; returns [[score, move]...] best first, and the depth reached
  deadline = performance.now() + budget; aborted = false; nodes = 0; killers = []; history = {}; TT = new Map();
  let scored = ms.map(m => [0, m]), pv = null, depth = 0;
  for (let d = 1; d <= maxD && !aborted; d++) {
    const trial = []; let alpha = -Infinity;
    for (const m of orderMoves(st, ms, 0, pv)) {
      const u = make(st, m); const v = -search(st, d - 1, -Infinity, -alpha, 1, 0); unmake(st, u);
      if (aborted) break;
      trial.push([v > alpha ? v : Math.min(v, alpha - 0.1), m]); if (v > alpha) alpha = v;
    }
    if (aborted) { if (trial.length && trial[0][0] >= scored[0][0]) scored = trial.concat(scored.filter(x => !trial.some(t => t[1] === x[1]))); break; }
    trial.sort((a, b) => b[0] - a[0]); scored = trial; pv = scored[0][1]; depth = d;
    if (Math.abs(scored[0][0]) > MATE - 100) break;
  }
  return { scored, depth };
}
function think(st, level, maxMs) {   // maxMs: a cap on thinking time, so a bot on a clock doesn't flag itself
  const ms = legal(st); if (!ms.length) return null;
  let budget = level === "easy" ? 200 : level === "normal" ? 1500 : 5000; if (maxMs) budget = Math.max(50, Math.min(budget, maxMs));
  const maxD = level === "easy" ? 1 : level === "normal" ? 8 : 12;
  const { scored } = searchRoot(st, ms, budget, maxD);
  if (level === "easy") { const top = scored.filter(x => x[0] >= scored[0][0] - 1.5); return top[Math.floor(Math.random() * top.length)][1]; }
  const ties = scored.filter(x => x[0] >= scored[0][0] - 0.05); return ties[Math.floor(Math.random() * ties.length)][1];
}
// analysis for the eval bar: the position's value from White's side in pawns, or a mate distance, plus the best move found
function analyse(st, budget) {
  const over = status(st);
  if (over) return { v: over.result === "d" ? 0 : over.result === "w" ? Infinity : -Infinity, mate: 0, m: null, depth: 0 };
  const { scored, depth } = searchRoot(st, legal(st), budget || 800, 10);
  let v = scored[0][0], mate = null;
  if (Math.abs(v) > MATE - 100) { const plies = MATE + 50 - Math.abs(v); mate = Math.sign(v) * Math.ceil(plies / 2); }   // from the side to move
  if (st.turn === 1) { v = -v; if (mate !== null) mate = -mate; }
  return { v, mate, m: scored[0][1], depth };
}
// ---- worker entry point: the page posts a position, gets a move (or an evaluation) back ----
if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  self.onmessage = e => {
    const { id, board, turn, cr, ep, half, swap, hand, ply, rest, setup, level, maxMs, kind, budget } = e.data;
    const st = { b: unpack(board), turn, cr: [cr[0].slice(), cr[1].slice()], ep, half, swap: (swap || [false, false]).slice(), hand: (hand || [true, true]).slice(), ply: ply || 0, rest: cloneRest(rest || []), over: null, last: null, setup: setup || CLASSIC };
    if (kind === "eval") { const r = analyse(st, budget); self.postMessage({ id, kind, v: r.v === Infinity ? 1e9 : r.v === -Infinity ? -1e9 : r.v, mate: r.mate, m: r.m, depth: r.depth, nodes }); return; }
    const m = think(st, level, maxMs);
    self.postMessage({ id, m, nodes });
  };
}
// ===================== end engine =====================
