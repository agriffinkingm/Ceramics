// Timur's chess — rules engine and computer player. Loaded by timur.html on the page and again inside a Web Worker.
"use strict";
// ===================== engine =====================
// Squares 0..109 are the 11×10 camp (index = rank*11 + file, a1 = 0). 110 = White's citadel (right of k2), 111 = Black's (left of a9).
const CIT_W = 110, CIT_B = 111, FILES = "abcdefghijk";
const ROYAL = { K: 1, P: 1, A: 1 };
const NAME = { K: "king", P: "prince", A: "adventitious king", G: "general", V: "vizier", Z: "giraffe", T: "picket", N: "knight", R: "rook", E: "elephant", C: "camel", D: "war engine", p: "pawn" };
const PERSIAN = { K: "shah", P: "shahzada", A: "shah", G: "ferz", V: "wazir", Z: "zurafa", T: "tali'a", N: "faras", R: "rukh", E: "pil", C: "jamal", D: "dabbaba", p: "baidaq" };
const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]], DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const KN = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
const CAM = [[1, 3], [3, 1], [-1, 3], [-3, 1], [1, -3], [3, -1], [-1, -3], [-3, -1]];
const ELE = [[2, 2], [2, -2], [-2, 2], [-2, -2]], DAB = [[2, 0], [-2, 0], [0, 2], [0, -2]];
const nsq = (x, y) => (x >= 0 && x < 11 && y >= 0 && y < 10) ? y * 11 + x : -1;          // camp only
const asq = (x, y) => { const i = nsq(x, y); if (i >= 0) return i; if (x === 11 && y === 1) return CIT_W; if (x === -1 && y === 8) return CIT_B; return -1; }; // incl. citadels
const xy = i => i === CIT_W ? [11, 1] : i === CIT_B ? [-1, 8] : [i % 11, Math.floor(i / 11)];
const sqName = i => i === CIT_W ? "citadel" : i === CIT_B ? "citadel" : FILES[i % 11] + (Math.floor(i / 11) + 1);
const fwd = c => c === 0 ? 1 : -1, lastRank = c => c === 0 ? 9 : 0;
const home = (c, arr) => arr === "f" ? (c === 0 ? nsq(5, 1) : nsq(5, 8)) : (c === 0 ? nsq(5, 2) : nsq(5, 7));   // where the pawn of kings starts
const enemyCit = c => c === 0 ? CIT_B : CIT_W, ownCit = c => c === 0 ? CIT_W : CIT_B;

// Two historical arrays (Murray / Wikipedia): "masculine" — leapers on the back rank, king on the second;
// "feminine" — the king, general and vizier drop to the back rank between the camels, the war engines take the pickets'
// old squares, and the pawn of kings stands on f2 directly in front of the king. Lower-case letters in a row are pawns.
const ARRAYS = {
  m: ["E.C.D.D.C.E", "RNTZGKVZTNR", "pdcegkvztnr"],
  f: ["E.C.GKV.C.E", "RNDTZkZTDNR", "pdceg.vztnr"],
};
function initialBoard(arr = "m") {
  const b = new Array(112).fill(null), rows = ARRAYS[arr] || ARRAYS.m;
  rows.forEach((row, y) => { for (let x = 0; x < 11; x++) {
    const ch = row[x]; if (ch === ".") continue;
    const mk = c => { if (ch === ch.toLowerCase()) { const pt = ch.toUpperCase() === "P" ? "p" : ch.toUpperCase(); const q = { c, t: "p", pt }; if (pt === "p") q.n = 0; return q; } return { c, t: ch }; };
    b[nsq(x, y)] = mk(0); b[nsq(10 - x, 9 - y)] = mk(1);
  } });
  return b;
}
function newState(arr = "m") { return { b: initialBoard(arr), turn: 0, swap: [false, false], over: null, last: null, arr }; }
function pack(b) { return b.map(p => p ? (p.c ? "b" : "w") + p.t + (p.t === "p" ? p.pt + (p.pt === "p" ? (p.n || 0) + (p.park ? "*" : "") : "") : "") : ".").join(" "); }
function unpack(s) {
  return s.split(" ").map(t => { if (t === ".") return null; const p = { c: t[0] === "b" ? 1 : 0, t: t[1] }; if (p.t === "p") { p.pt = t[2]; if (p.pt === "p") { p.n = +t[3] || 0; if (t[4] === "*") p.park = true; } } return p; });
}
function royals(b, c) { let n = 0; for (let i = 0; i < 112; i++) { const p = b[i]; if (p && p.c === c && ROYAL[p.t]) n++; } return n; }
function highest(b, c) { let h = null; for (let i = 0; i < 112; i++) { const p = b[i]; if (p && p.c === c && ROYAL[p.t]) { if (p.t === "K") return "K"; if (p.t === "P") h = "P"; else if (!h) h = "A"; } } return h; }
function royalSq(b, c) { for (let i = 0; i < 112; i++) { const p = b[i]; if (p && p.c === c && ROYAL[p.t]) return i; } return -1; }
const immune = (b, i) => { const p = b[i]; return !!(p.park || (p.t === "A" && i === ownCit(p.c))); };

function giraffeTargets(b, i) {   // every square a giraffe on i reaches, the first occupied square of each line included
  const out = [], [x, y] = xy(i);
  for (const [dx, dy] of DIAG) {
    const s1 = nsq(x + dx, y + dy); if (s1 < 0 || b[s1]) continue;
    for (const [ex, ey] of [[dx, 0], [0, dy]]) {
      let cx = x + dx, cy = y + dy, ok = true;
      for (let k = 1; k <= 2; k++) { cx += ex; cy += ey; const j = nsq(cx, cy); if (j < 0 || b[j]) { ok = false; break; } }
      if (!ok) continue;
      for (; ;) { cx += ex; cy += ey; const j = nsq(cx, cy); if (j < 0) break; out.push(j); if (b[j]) break; }
    }
  }
  return out;
}
function ray(b, x, y, dx, dy, skipFirst, fn) {   // fn(j, piece) → false to stop
  let cx = x, cy = y, k = 0;
  for (; ;) { cx += dx; cy += dy; k++; const j = nsq(cx, cy); if (j < 0) return; const q = b[j]; if (skipFirst && k === 1) { if (q) return; continue; } if (fn(j, q) === false) return; if (q) return; }
}
function attacked(b, i, by) {   // is square i attacked by colour `by`?
  const [x, y] = xy(i);
  const has = (j, ts) => { if (j < 0) return false; const q = b[j]; return !!(q && q.c === by && ts.includes(q.t)); };
  for (const [dx, dy] of DIRS8) { const j = asq(x + dx, y + dy); if (has(j, "KPA")) return true; }
  for (const [dx, dy] of DIAG) if (has(nsq(x + dx, y + dy), "G")) return true;
  for (const [dx, dy] of ORTH) if (has(nsq(x + dx, y + dy), "V")) return true;
  for (const [dx, dy] of KN) if (has(nsq(x + dx, y + dy), "N")) return true;
  for (const [dx, dy] of CAM) if (has(nsq(x + dx, y + dy), "C")) return true;
  for (const [dx, dy] of ELE) if (has(nsq(x + dx, y + dy), "E")) return true;
  for (const [dx, dy] of DAB) if (has(nsq(x + dx, y + dy), "D")) return true;
  const f = fwd(by);
  for (const dx of [-1, 1]) { const j = nsq(x + dx, y - f); const q = j >= 0 && b[j]; if (q && q.c === by && q.t === "p" && !q.park) return true; }
  let hit = false;
  for (const [dx, dy] of ORTH) { ray(b, x, y, dx, dy, false, (j, q) => { if (q && q.c === by && q.t === "R") hit = true; }); if (hit) return true; }
  for (const [dx, dy] of DIAG) { ray(b, x, y, dx, dy, true, (j, q) => { if (q && q.c === by && q.t === "T") hit = true; }); if (hit) return true; }
  // giraffe: walk back ≥3 straight squares (all empty), then the diagonal step back — the square the straight leg started on must be empty too
  for (const [ex, ey] of ORTH) {
    let cx = x, cy = y;
    for (let k = 1; ; k++) {
      cx -= ex; cy -= ey; const j = nsq(cx, cy); if (j < 0 || b[j]) break;        // every square on the way back, incl. the turn square, must be empty
      if (k < 3) continue;
      for (const perp of [-1, 1]) { const gx = ex ? cx - ex : cx - perp, gy = ey ? cy - ey : cy - perp; const gj = nsq(gx, gy); const q = gj >= 0 && b[gj]; if (q && q.c === by && q.t === "Z") return true; }
    }
  }
  return false;
}
// pseudo-legal moves of the piece on i. kinds: m move/capture, c into the enemy citadel (draw), h adventitious king home, s king swap, r pawn-of-pawns drop
function pieceMoves(st, i, out, er) {
  const b = st.b, p = b[i], c = p.c, [x, y] = xy(i); if (er === undefined) er = royals(b, 1 - c);
  const canCap = j => { const q = b[j]; return q.c !== c && !immune(b, j) && !(ROYAL[q.t] && er < 2); };
  const add = (j, k = "m") => out.push({ f: i, t: j, k });
  const step = j => { if (j < 0) return; const q = b[j]; if (!q) add(j); else if (canCap(j)) add(j); };
  const slide = (dirs, skip) => { for (const [dx, dy] of dirs) ray(b, x, y, dx, dy, skip, (j, q) => { if (!q) add(j); else if (canCap(j)) add(j); }); };
  switch (p.t) {
    case "K": case "P": case "A": {
      const hi = highest(b, c);
      for (const [dx, dy] of DIRS8) {
        const j = asq(x + dx, y + dy); if (j < 0) continue;
        if (j === CIT_W || j === CIT_B) { if (b[j]) continue; if (j === enemyCit(c)) { if (p.t === hi) add(j, "c"); } else if (p.t === "A") add(j, "h"); continue; }
        step(j);
      }
      if (p.t === "K" && !st.swap[c] && attacked(b, i, 1 - c)) {
        for (let j = 0; j < 110; j++) { const q = b[j]; if (!q || q.c !== c || ROYAL[q.t]) continue; if (q.t === "p" && (q.park || y === lastRank(c))) continue; add(j, "s"); }
      }
      break;
    }
    case "G": for (const [dx, dy] of DIAG) step(nsq(x + dx, y + dy)); break;
    case "V": for (const [dx, dy] of ORTH) step(nsq(x + dx, y + dy)); break;
    case "N": for (const [dx, dy] of KN) step(nsq(x + dx, y + dy)); break;
    case "C": for (const [dx, dy] of CAM) step(nsq(x + dx, y + dy)); break;
    case "E": for (const [dx, dy] of ELE) step(nsq(x + dx, y + dy)); break;
    case "D": for (const [dx, dy] of DAB) step(nsq(x + dx, y + dy)); break;
    case "R": slide(ORTH, false); break;
    case "T": slide(DIAG, true); break;
    case "Z": for (const j of giraffeTargets(b, i)) { if (!b[j]) add(j); else if (canCap(j)) add(j); } break;
    case "p": {
      if (p.park) { dropSquares(st, i, out); break; }
      const f = fwd(c), ty = y + f, last = ty === lastRank(c);
      const okProm = () => { if (!last || p.pt !== "p" || p.n !== 1) return true; const h = b[home(c, st.arr)]; return !(h && ROYAL[h.t]); };   // second promotion lands on f3/f8
      const j = nsq(x, ty); if (j >= 0 && !b[j] && okProm()) add(j);
      for (const dx of [-1, 1]) { const k = nsq(x + dx, ty); if (k >= 0 && b[k] && canCap(k) && okProm()) add(k); }
      break;
    }
  }
}
function dropSquares(st, i, out) {   // parked pawn of pawns: squares where it would fork two pieces, or attack one that cannot move
  const b = st.b, p = b[i], c = p.c, f = fwd(c);
  for (let j = 0; j < 110; j++) {
    if (j === i) continue; const [tx, ty] = xy(j); if (ty === lastRank(c)) continue;
    if (b[j] && ROYAL[b[j].t]) continue;
    const hits = [];
    for (const dx of [-1, 1]) { const k = nsq(tx + dx, ty + f); if (k >= 0 && b[k] && b[k].c !== c && !immune(b, k)) hits.push(k); }
    if (hits.length >= 2) out.push({ f: i, t: j, k: "r" });
    else if (hits.length === 1) { const tmp = []; pieceMoves(st, hits[0], tmp); if (!tmp.length) out.push({ f: i, t: j, k: "r" }); }
  }
}
function gen(st, c = st.turn) { const out = [], er = royals(st.b, 1 - c); for (let i = 0; i < 112; i++) { const p = st.b[i]; if (p && p.c === c) pieceMoves(st, i, out, er); } return out; }
function make(st, m) {
  const b = st.b, u = { ch: [], turn: st.turn, swap: st.swap.slice(), over: st.over, last: st.last };
  const set = (i, p) => { u.ch.push([i, b[i]]); b[i] = p; };
  const p = b[m.f], c = p.c;
  if (m.k === "s") { const q = b[m.t]; set(m.t, p); set(m.f, q); st.swap[c] = true; }
  else if (m.k === "r") { set(m.f, null); set(m.t, { c, t: "p", pt: "p", n: p.n }); }
  else {
    const ty = xy(m.t)[1]; let np = p, relocate = false;
    if (p.t === "p" && ty === lastRank(c)) {
      if (p.pt === "K") np = { c, t: "P" };
      else if (p.pt === "p") { if (p.n === 0) np = { c, t: "p", pt: "p", n: 1, park: true }; else if (p.n === 1) relocate = true; else np = { c, t: "A" }; }
      else np = { c, t: p.pt };
    }
    set(m.f, null);
    if (relocate) { set(m.t, null); set(home(c, st.arr), { c, t: "p", pt: "p", n: 2 }); }
    else set(m.t, np);
    if (m.k === "c") st.over = { result: "d", why: "the king reached the citadel" };
  }
  st.last = [m.f, m.t]; st.turn = 1 - c; return u;
}
function unmake(st, u) { for (let k = u.ch.length - 1; k >= 0; k--) st.b[u.ch[k][0]] = u.ch[k][1]; st.turn = u.turn; st.swap = u.swap; st.over = u.over; st.last = u.last; }
function inCheck(st, c) {
  const b = st.b; if (royals(b, c) !== 1) return false;
  const r = royalSq(b, c); if (r === ownCit(c) || r === enemyCit(c)) return false;
  return attacked(b, r, 1 - c);
}
function legal(st) {
  const c = st.turn, out = [];
  for (const m of gen(st, c)) { const u = make(st, m); const bad = !st.over && inCheck(st, c); unmake(st, u); if (!bad) out.push(m); }
  return out;
}
function status(st) {   // null while the game goes on
  if (st.over) return st.over;
  const c = st.turn, other = c ? "w" : "b";
  if (royals(st.b, c) === 0) return { result: other, why: "no king left" };
  if (!legal(st).length) return { result: other, why: inCheck(st, c) ? "checkmate" : "stalemate" };
  return null;
}
function notation(st, m) {
  const p = st.b[m.f], q = st.b[m.t], nm = p.t === "p" ? "p" + (p.pt === "p" ? "p" : p.pt.toLowerCase()) : p.t;
  if (m.k === "s") return "K⇄" + (q.t === "p" ? "p" : q.t) + " " + sqName(m.t);
  if (m.k === "r") return "pp→" + sqName(m.t) + (q ? "×" : "");
  if (m.k === "c") return p.t + " " + sqName(m.f) + "→citadel ½";
  if (m.k === "h") return "A " + sqName(m.f) + "→citadel";
  let s = nm + " " + sqName(m.f) + (q ? "×" : "–") + sqName(m.t);
  if (p.t === "p" && xy(m.t)[1] === lastRank(p.c)) s += p.pt === "K" ? "=P" : p.pt === "p" ? (p.n === 0 ? " parks" : p.n === 1 ? " →" + sqName(home(p.c, st.arr)) : "=A") : "=" + p.pt;
  return s;
}

// ---------- the computer: alpha-beta over legal moves, captures-only quiescence, iterative deepening on a time budget ----------
const VAL = { K: 0, P: 2.5, A: 2.5, G: 2.1, V: 2.2, Z: 6.5, T: 3.2, N: 3.6, R: 7, E: 1.4, C: 2.1, D: 1.4, p: 1 };
function evaluate(st) {
  const b = st.b; let s = 0; const rc = [0, 0], mat = [0, 0], ksq = [-1, -1];
  for (let i = 0; i < 112; i++) {
    const p = b[i]; if (!p) continue; let v = VAL[p.t];
    if (ROYAL[p.t]) { rc[p.c]++; if (ksq[p.c] < 0 || p.t === "K") ksq[p.c] = i; } else if (p.t !== "p") mat[p.c] += v;
    if (p.t === "p") { const y = xy(i)[1], adv = p.c === 0 ? y - 2 : 7 - y; v += adv * 0.12 + (p.pt === "K" ? .6 : p.pt === "p" ? .4 : VAL[p.pt] * 0.06) + (p.park ? .8 : 0); }
    s += p.c === 0 ? v : -v;
  }
  s += (Math.max(0, rc[0] - 1) - Math.max(0, rc[1] - 1)) * 9;
  // endgame: when a side has little left, the other side scores for cornering its king and bringing its own king close
  for (const c of [0, 1]) {
    if (mat[c] > 8 || ksq[c] < 0 || ksq[1 - c] < 0 || mat[1 - c] < 3) continue;
    const [kx, ky] = xy(ksq[c]), [ox, oy] = xy(ksq[1 - c]);
    const edge = Math.max(Math.abs(kx - 5), Math.abs(ky - 4.5) * 1.1), dist = Math.max(Math.abs(kx - ox), Math.abs(ky - oy));
    const bonus = edge * 0.12 + (10 - dist) * 0.06;
    s += c === 0 ? -bonus : bonus;
  }
  return st.turn === 0 ? s : -s;
}
let nodes = 0, deadline = 0, aborted = false;
const MATE = 1000;
let killers = [], history = {};
// transposition table: the key is hashed from scratch each node (cheap next to move generation), entries keep depth, value, bound type and best move
const ZOB = [], ZCODE = new Map(); let zrng = 0x9E3779B9;
const zr = () => { zrng ^= zrng << 13; zrng ^= zrng >>> 17; zrng ^= zrng << 5; return zrng >>> 0; };
for (let i = 0; i < 112; i++) ZOB.push([]);
const ZTURN = [zr(), zr()], ZSWAP = [[zr(), zr()], [zr(), zr()]];
function zcode(p) { const k = p.c + p.t + (p.t === "p" ? p.pt + (p.n || 0) + (p.park ? "*" : "") : ""); let c = ZCODE.get(k); if (c === undefined) { c = ZCODE.size; ZCODE.set(k, c); } return c; }
function zkey(st) {
  let h1 = 0, h2 = 0x85EBCA6B;
  for (let i = 0; i < 112; i++) { const p = st.b[i]; if (!p) continue; const c = zcode(p); const row = ZOB[i]; while (row.length < 2 * (c + 1)) row.push(zr(), zr()); h1 ^= row[c * 2]; h2 ^= row[c * 2 + 1]; }
  h1 ^= ZTURN[st.turn]; h2 ^= ZSWAP[0][st.swap[0] ? 1 : 0] ^ ZSWAP[1][st.swap[1] ? 1 : 0];
  return h1 * 2097152 + (h2 >>> 11);                       // 53 bits: stays an exact integer in a double
}
let TT = new Map(); const TT_MAX = 400000;
const mkey = m => m.f * 112 + m.t;
function orderMoves(st, ms, ply, pv) {
  const b = st.b, k = killers[ply] || [];
  return ms.map(m => {
    const q = b[m.t]; let sc = 0;
    if (pv && m.f === pv.f && m.t === pv.t && m.k === pv.k) sc = 1e6;
    else if (q && m.k !== "s") sc = 10000 + VAL[q.t] * 100 - VAL[b[m.f].t];           // captures: most valuable victim, least valuable attacker
    else if (m.k === "r") sc = 12000;
    else if (k[0] && k[0].f === m.f && k[0].t === m.t) sc = 9000; else if (k[1] && k[1].f === m.f && k[1].t === m.t) sc = 8000;
    else sc = history[mkey(m)] || 0;
    if (b[m.f].t === "p" && xy(m.t)[1] === lastRank(b[m.f].c)) sc += 5000;             // promotions
    return [sc, m];
  }).sort((a, c) => c[0] - a[0]).map(x => x[1]);
}
// legal moves without the make/unmake round trip for each: callers make the move and reject it if their own king is left in check
function tryMove(st, m) { const c = st.turn, u = make(st, m); if (!st.over && royals(st.b, c) === 1 && inCheck(st, c)) { unmake(st, u); return null; } return u; }
function quiesce(st, alpha, beta, d, ply) {
  nodes++;
  if (st.over) return st.over.result === "d" ? 0 : -MATE;
  const c = st.turn, check = inCheck(st, c);
  if (check && d > -3) {                                   // in check: no standing pat — every evasion is searched, and no evasion is mate
    let any = false, best = -Infinity;
    for (const m of orderMoves(st, gen(st, c), ply)) { const u = tryMove(st, m); if (!u) continue; any = true; const v = -quiesce(st, -beta, -alpha, d - 1, ply + 1); unmake(st, u); if (v > best) best = v; if (v > alpha) alpha = v; if (alpha >= beta) break; }
    return any ? best : -(MATE + 50 - ply);
  }
  const stand = evaluate(st); if (stand >= beta || d <= 0) return stand; if (stand > alpha) alpha = stand;
  let best = stand;                                        // fail-soft: never report an inflated alpha as the value
  const ms = orderMoves(st, gen(st, c).filter(m => (st.b[m.t] && m.k !== "s") || m.k === "r" || m.k === "c"), ply);
  for (const m of ms) { const u = tryMove(st, m); if (!u) continue; const v = -quiesce(st, -beta, -alpha, d - 1, ply + 1); unmake(st, u); if (v > best) best = v; if (v >= beta) return v; if (v > alpha) alpha = v; }
  return best;
}
function search(st, depth, alpha, beta, ply, ext) {
  nodes++; if ((nodes & 1023) === 0 && performance.now() > deadline) aborted = true;
  if (st.over) return st.over.result === "d" ? 0 : -MATE;
  if (depth <= 0) return quiesce(st, alpha, beta, 3, ply);
  const key = zkey(st), tt = TT.get(key), alpha0 = alpha;
  if (tt && tt.depth >= depth) { if (tt.flag === 0) return tt.v; if (tt.flag === 1 && tt.v >= beta) return tt.v; if (tt.flag === 2 && tt.v <= alpha) return tt.v; }
  const c = st.turn; let any = false, best = -Infinity, bestM = null;
  for (const m of orderMoves(st, gen(st, c), ply, tt && tt.m)) {
    const u = tryMove(st, m); if (!u) continue; any = true;
    const givesCheck = !st.over && royals(st.b, st.turn) === 1 && inCheck(st, st.turn);
    const e = givesCheck && ext < 3 ? 1 : 0;                // follow checks a little deeper: that's where the ladders and the mates in two live
    const v = -search(st, depth - 1 + e, -beta, -alpha, ply + 1, ext + e); unmake(st, u);
    if (aborted) return best;
    if (v > best) { best = v; bestM = m; }
    if (v > alpha) alpha = v;
    if (alpha >= beta) { if (!st.b[m.t]) { const k = killers[ply] || (killers[ply] = []); if (!k[0] || k[0].f !== m.f || k[0].t !== m.t) { k[1] = k[0]; k[0] = m; } history[mkey(m)] = (history[mkey(m)] || 0) + depth * depth; } break; }
  }
  if (!any) return -(MATE + 50 - ply);                      // mated or stalemated: both lose here; sooner is worse for the loser
  if (!aborted) { if (TT.size > TT_MAX) TT.clear(); TT.set(key, { depth, v: best, flag: best <= alpha0 ? 2 : best >= beta ? 1 : 0, m: bestM }); }
  return best;
}
function think(st, level) {
  const ms = legal(st); if (!ms.length) return null;
  const budget = level === "easy" ? 200 : level === "normal" ? 1500 : 5000, maxD = level === "easy" ? 1 : level === "normal" ? 8 : 12;
  deadline = performance.now() + budget; aborted = false; nodes = 0; killers = []; history = {}; TT = new Map();
  let scored = ms.map(m => [0, m]), pv = null;
  for (let d = 1; d <= maxD && !aborted; d++) {
    const trial = []; let alpha = -Infinity;
    for (const m of orderMoves(st, ms, 0, pv)) {
      const u = make(st, m); const v = -search(st, d - 1, -Infinity, -alpha, 1, 0); unmake(st, u);
      if (aborted) break;
      // a value above alpha is exact; one at or below it is only a bound ("no better than the best so far"), so it must not tie with the best
      trial.push([v > alpha ? v : Math.min(v, alpha - 0.1), m]); if (v > alpha) alpha = v;
    }
    if (aborted) { if (trial.length && trial[0][0] >= scored[0][0]) scored = trial.concat(scored.filter(x => !trial.some(t => t[1] === x[1]))); break; }   // a partial iteration still tells us about its first (best-so-far) moves
    trial.sort((a, b) => b[0] - a[0]); scored = trial; pv = scored[0][1];
    if (Math.abs(scored[0][0]) > MATE - 100) break;        // a forced mate found (or unavoidable): no need to look further
  }
  if (level === "easy") { const top = scored.filter(x => x[0] >= scored[0][0] - 1.5); return top[Math.floor(Math.random() * top.length)][1]; }
  const ties = scored.filter(x => x[0] >= scored[0][0] - 0.05); return ties[Math.floor(Math.random() * ties.length)][1];
}
// ---- worker entry point: the page posts a position, gets a move back ----
if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  self.onmessage = e => {
    const { id, board, turn, swap, arr, level } = e.data;
    const st = { b: unpack(board), turn, swap: swap.slice(), over: null, last: null, arr: arr || "m" };
    const m = think(st, level);
    self.postMessage({ id, m, nodes });
  };
}
// ===================== end engine =====================
