#!/usr/bin/env python3
"""
Daily news backdrop for the graffiti wall.

Runs from .github/workflows/daily-bg.yml. Steps:
  1. Pull the last 10 days of English headlines from GDELT (free, keyless),
     biased toward disasters / emergencies / catastrophes / scandals.
  2. Ask the Pollinations text model to rank the stories (dramatic + likely a
     far/wide view), then LOOK at the top photos with the vision model and take
     the widest, most panoramic / aerial one (headline order if vision is down).
  3. Download the article's social/og image.
  4. Outpaint it to a 16:9 frame via gen.pollinations.ai edits (nanobanana),
     upscale to the wall (3456x1944) and paste the ORIGINAL photo back over its
     region with a feathered edge so the real pixels stay crisp.
     If the photo is already ~16:9, or the edit fails, cover-crop instead.
  5. Write bg/current.jpg, bg/current.json, append bg/history.json.

Env: POLLINATIONS_KEY (repo secret). Falls back to the sk_ key embedded in graff.html.
Flags: --dry (pick + download, skip generation) --force (ignore history dedupe)
"""
import base64, datetime as dt, io, json, os, re, sys, time, urllib.parse
import requests
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BG = os.path.join(ROOT, "bg")
W, H = 3456, 1944
GEN_W, GEN_H = 1024, 576                 # nanobanana works at ~1024 long side
UA = {"User-Agent": "Mozilla/5.0 (graffwall daily backdrop; +https://agriffinkingm.com)"}
DRY = "--dry" in sys.argv
FORCE = "--force" in sys.argv
POOL_MODE = "--pool" in sys.argv   # top up bg/pool.json with fresh wide scenes; leave current.* alone

# GDELT rejects long queries ("Your query was too short or too long", ~250 char cap)
# and rate-limits to one request per 5 seconds, so this is split into short queries
# fetched sequentially with a pause.
QUERIES = [
    '(flood OR earthquake OR wildfire OR hurricane OR typhoon OR eruption OR tsunami) sourcelang:eng',
    '(explosion OR collapse OR derailment OR "plane crash" OR "state of emergency" OR landslide) sourcelang:eng',
    '(evacuation OR "dam breach" OR outbreak OR blackout OR "oil spill" OR scandal OR indicted OR riot) sourcelang:eng',
    # GDELT tags the lead photo of every article — these pull stories whose PHOTO is the
    # long view, whatever the story is about, from anywhere in the world
    'imagetag:"aerial photography" sourcelang:eng',
    'imagetag:"bird\'s-eye view" sourcelang:eng',
    '(imagetag:"skyline" OR imagetag:"cityscape") sourcelang:eng',
    '(imagetag:"landscape" OR imagetag:"mountain range" OR imagetag:"coast") sourcelang:eng',
    '(imagetag:"crowd" OR imagetag:"stadium" OR imagetag:"protest") sourcelang:eng',
    '(imagetag:"satellite imagery" OR imagetag:"volcano" OR imagetag:"glacier") sourcelang:eng',
]
GOOD_DOMAINS = ("reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "theguardian.com",
                "aljazeera.com", "npr.org", "cnn.com", "nytimes.com", "washingtonpost.com",
                "france24.com", "dw.com", "abc.net.au", "cbc.ca", "nbcnews.com", "cbsnews.com",
                "abcnews.go.com", "euronews.com", "kathmandupost.com", "scmp.com", "latimes.com")
BAD_WORDS = ("opinion", "explainer", "podcast", "live updates", "how to", "quiz", "horoscope")
DISASTER_WORDS = ("flood", "quake", "fire", "hurricane", "typhoon", "cyclone", "erupt", "explo",
                  "collaps", "crash", "emergency", "evacuat", "breach", "landslide", "tsunami",
                  "outbreak", "blackout", "spill", "dead", "killed", "destroy", "scandal", "indict")
# the wall wants the long view: aerial / drone / panoramic / satellite shots of the scene
VISTA_WORDS = ("aerial", "drone", "from above", "satellite", "panoram", "bird's-eye", "birds-eye",
               "overhead", "sweep", "swath", "skyline", "landscape", "footage shows", "images show")
VISION_N = 10          # how many top candidates get their photo looked at (16 in --pool mode)
VISTA_MIN = 4          # below this the photo is a close-up/portrait/graphic — skipped if anything better exists


def log(*a):
    print(*a, flush=True)


def pollinations_key():
    k = os.environ.get("POLLINATIONS_KEY", "").strip()
    if k:
        return k
    try:
        src = open(os.path.join(ROOT, "graff.html"), encoding="utf-8").read()
        m = re.search(r'POLLINATIONS_KEY\s*=\s*"(sk_[A-Za-z0-9]+)"', src)
        if m:
            return m.group(1)
    except OSError:
        pass
    return ""


KEY = pollinations_key()
# text + vision: the legacy text.pollinations.ai endpoint was deprecated (402 for
# everyone, Sep 2026); the OpenAI-compatible one on gen.pollinations.ai takes the
# same sk_ key as image generation and does vision (image_url content parts).
CHAT_URL = "https://gen.pollinations.ai/v1/chat/completions"


def chat_headers():
    return {"Content-Type": "application/json", **({"Authorization": "Bearer " + KEY} if KEY else {})}


# ---------------------------------------------------------------- 1. headlines
def fetch_gdelt():
    arts, seen = [], set()
    for qi, q in enumerate(QUERIES):
        url = ("https://api.gdeltproject.org/api/v2/doc/doc?" + urllib.parse.urlencode({
            "query": q, "mode": "ArtList", "format": "json", "maxrecords": 60,
            "timespan": "10d", "sort": "DateDesc"}))
        for attempt in range(3):
            if qi or attempt:
                time.sleep(7)   # GDELT: one request per 5s
            try:
                r = requests.get(url, headers=UA, timeout=40)
                r.raise_for_status()
                try:
                    batch = r.json().get("articles", [])
                except ValueError:
                    log("gdelt non-json reply:", r.text[:120])
                    continue
                for a in batch:
                    u = a.get("url")
                    if u and u not in seen:
                        seen.add(u)
                        arts.append(a)
                break
            except Exception as e:
                log("gdelt q%d attempt %d:" % (qi, attempt), e)
    return arts


def load_history():
    try:
        return json.load(open(os.path.join(BG, "history.json"), encoding="utf-8"))
    except Exception:
        return []


STOP = {"After", "With", "From", "Over", "Into", "This", "That", "What", "When", "Where", "While",
        "Will", "Have", "Been", "Says", "Said", "Amid", "More", "Than", "Live", "News", "Watch",
        "Video", "Photos", "Here", "Their", "They", "Your", "About", "Just", "Some", "Also"}


def topic_words(headlines):
    """Place / name / event stems from recent picks — used to steer away from the same
    story or country showing up again and again. Capitalised words are keyed by their
    first six letters (Indonesia ≈ Indonesian), plus disaster-type stems (erupt, flood…)."""
    out = set()
    for h in headlines:
        h = h or ""
        for w in re.findall(r"[A-Z][a-zA-Z'\-]{3,}", h):
            if w not in STOP:
                out.add(w.lower()[:6])
        low = h.lower()
        for stem in DISASTER_WORDS:
            if stem in low:
                out.add("#" + stem)
    return out


def ahash(im):
    """64-bit average hash — catches the same wire photo run by different outlets."""
    g = im.convert("L").resize((8, 8), Image.LANCZOS)
    px = list(g.getdata())
    avg = sum(px) / 64.0
    return sum(1 << i for i, p in enumerate(px) if p > avg)


def hamming(a, b):
    return bin((a or 0) ^ (b or 0)).count("1")


def load_pool():
    try:
        return json.load(open(os.path.join(BG, "pool.json"), encoding="utf-8"))
    except Exception:
        return []


def candidates(arts, history):
    pool = load_pool()
    recent = history[-30:]
    seen_urls = {h.get("url") for h in recent} | {p.get("url") for p in pool}
    seen_heads = {(h.get("headline") or "").lower()[:40] for h in recent} | {(p.get("headline") or "").lower()[:40] for p in pool}
    topics = topic_words([h.get("headline") for h in history[-8:]] + [p.get("headline") for p in pool])
    out, dedupe = [], set()
    for a in arts:
        img, title, url = a.get("socialimage") or "", (a.get("title") or "").strip(), a.get("url") or ""
        dom = (a.get("domain") or "").lower()
        if not img or not title or not url or len(title) < 20:
            continue
        if any(b in title.lower() for b in BAD_WORDS):
            continue
        key = title.lower()[:40]
        if key in dedupe or (not FORCE and (url in seen_urls or key in seen_heads)):
            continue
        dedupe.add(key)
        score = sum(2 for w in DISASTER_WORDS if w in title.lower())
        score += sum(3 for w in VISTA_WORDS if w in title.lower())
        if any(dom.endswith(g) for g in GOOD_DOMAINS):
            score += 3
        # same place / story as something already on the wall lately → push it down
        score -= 3 * len(topics & topic_words([title]))
        out.append({"title": title, "url": url, "domain": dom, "image": img,
                    "seendate": a.get("seendate", ""), "score": score})
    out.sort(key=lambda c: -c["score"])
    return out[:40]


# ---------------------------------------------------------------- 2. pick
def llm_pick(cands):
    """Ask the text model for the index of the most catastrophic, visually strong story."""
    if not cands:
        return None
    listing = "\n".join(f"{i}. [{c['domain']}] {c['title']}" for i, c in enumerate(cands))
    recent = [h.get("headline") for h in load_history()[-6:]] + [p.get("headline") for p in load_pool()]
    recent_txt = ("\n\nAlready used recently (pick a DIFFERENT place and story):\n" +
                  "\n".join("- " + (r or "") for r in recent[-12:])) if recent else ""
    prompt = ("You choose one news story per day whose photo becomes the backdrop of a public "
              "graffiti wall. Prefer, in order: disasters, emergencies, catastrophes, scandals, "
              "breaking news — the more dramatic and photographable the better. Strongly prefer "
              "stories whose photo is likely a FAR, WIDE view of the scene: aerial, drone, "
              "satellite, panoramic, bird's-eye, a whole city / coastline / valley / crowd seen "
              "from a distance. Avoid opinion pieces, portraits, press conferences, close-ups "
              "and stories without a clear physical scene. Vary the part of the world." + recent_txt +
              "\n\nStories:\n" + listing +
              "\n\nReply with ONLY the number of your pick.")
    try:
        r = requests.post(CHAT_URL, headers=chat_headers(),
                          json={"model": "openai", "messages": [{"role": "user", "content": prompt}],
                                "temperature": 0.3, "max_tokens": 8}, timeout=60)
        r.raise_for_status()
        txt = r.json()["choices"][0]["message"]["content"]
        m = re.search(r"\d+", txt)
        if m and 0 <= int(m.group()) < len(cands):
            log("llm picked", m.group(), txt.strip())
            return int(m.group())
    except Exception as e:
        log("llm pick failed:", e)
    return None


def vista_score(im):
    """Ask the vision model how much this photo is a far, wide, panoramic / aerial view.
    0 = close-up, portrait, headshot, object, graphic, text; 10 = sweeping bird's-eye vista.
    None if the model can't be reached — the caller falls back to headline order."""
    small = im.copy()
    small.thumbnail((640, 640), Image.LANCZOS)
    buf = io.BytesIO()
    small.save(buf, "JPEG", quality=80)
    b64 = base64.b64encode(buf.getvalue()).decode()
    prompt = ("Rate this news photo from 0 to 10 for how much it is a FAR, WIDE, LONG view of a "
              "scene: aerial or drone or satellite shots, panoramas, bird's-eye views, whole "
              "landscapes / cityscapes / coastlines / valleys / crowds seen from a distance score "
              "8-10. Medium shots of a street, a single building, rubble or a vehicle score 3-5. Close-ups, portraits, "
              "headshots, people talking, objects, logos, graphics or text score 0-2. "
              "Reply with ONLY the number.")
    try:
        r = requests.post(CHAT_URL, headers=chat_headers(),
                          json={"model": "openai",
                                "messages": [{"role": "user", "content": [
                                    {"type": "text", "text": prompt},
                                    {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}}]}],
                                "temperature": 0.1, "max_tokens": 6}, timeout=90)
        r.raise_for_status()
        txt = r.json()["choices"][0]["message"]["content"]
        m = re.search(r"\d+(\.\d+)?", txt)
        if m:
            return max(0.0, min(10.0, float(m.group())))
    except Exception as e:
        log("vista score failed:", e)
    return None


def download_image(url):
    r = requests.get(url, headers=UA, timeout=40)
    r.raise_for_status()
    im = Image.open(io.BytesIO(r.content))
    im.load()
    im = im.convert("RGB")
    if im.width < 500 or im.height < 280:
        raise ValueError(f"image too small {im.size}")
    return im


# ---------------------------------------------------------------- 4. outpaint
def cover(im, w, h):
    s = max(w / im.width, h / im.height)
    im2 = im.resize((max(w, round(im.width * s)), max(h, round(im.height * s))), Image.LANCZOS)
    x, y = (im2.width - w) // 2, (im2.height - h) // 2
    return im2.crop((x, y, x + w, y + h))


def contain_box(im, w, h):
    s = min(w / im.width, h / im.height)
    cw, ch = round(im.width * s), round(im.height * s)
    return (w - cw) // 2, (h - ch) // 2, cw, ch


def edit_call(png_bytes, prompt):
    """POST to gen.pollinations.ai edits; handle raw image / b64_json / url replies. 401 → Bearer retry."""
    def go(bearer):
        url = "https://gen.pollinations.ai/v1/images/edits" + ("" if bearer else "?key=" + KEY)
        hdr = {"Authorization": "Bearer " + KEY} if bearer else {}
        return requests.post(url, headers=hdr, files={"image": ("frame.png", png_bytes, "image/png")},
                             data={"model": "nanobanana", "prompt": prompt}, timeout=180)
    r = go(False)
    if r.status_code == 401:
        r = go(True)
    r.raise_for_status()
    ct = r.headers.get("content-type", "")
    if ct.startswith("image/"):
        return Image.open(io.BytesIO(r.content)).convert("RGB")
    j = r.json()
    d = (j.get("data") or [{}])[0]
    if d.get("b64_json"):
        return Image.open(io.BytesIO(base64.b64decode(d["b64_json"]))).convert("RGB")
    if d.get("url"):
        rr = requests.get(d["url"], headers=UA, timeout=120)
        rr.raise_for_status()
        return Image.open(io.BytesIO(rr.content)).convert("RGB")
    raise RuntimeError("edit reply had no image: " + str(j)[:200])


def outpaint(photo, headline):
    """Return (W×H image, method)."""
    ar = photo.width / photo.height
    if abs(ar - 16 / 9) < 0.06:
        return cover(photo, W, H), "crop"
    if DRY or not KEY:
        return cover(photo, W, H), "crop-dry"
    # frame the photo inside a 16:9 neutral canvas
    frame = Image.new("RGB", (GEN_W, GEN_H), (170, 166, 156))
    x, y, cw, ch = contain_box(photo, GEN_W, GEN_H)
    frame.paste(photo.resize((cw, ch), Image.LANCZOS), (x, y))
    buf = io.BytesIO()
    frame.save(buf, "PNG")
    prompt = ("This is a news photograph placed on a flat grey frame. Extend the photograph so "
              "it fills the ENTIRE frame edge to edge, continuing the same scene, lighting, "
              "weather and camera perspective naturally into the grey areas as if the camera "
              "had a much wider lens, revealing more of the surrounding landscape and distance. "
              "Keep every original photo pixel exactly unchanged. No text, "
              "no borders, no watermarks. Context: " + headline)
    try:
        gen = edit_call(buf.getvalue(), prompt)
    except Exception as e:
        log("outpaint failed → crop:", e)
        return cover(photo, W, H), "crop-fallback"
    big = cover(gen, W, H)
    # paste the original (higher-res) photo back over its region with a soft edge
    sx, sy = W / GEN_W, H / GEN_H
    px, py, pw, ph = round(x * sx), round(y * sy), round(cw * sx), round(ch * sy)
    orig = photo.resize((pw, ph), Image.LANCZOS)
    feather = max(12, round(min(pw, ph) * 0.03))
    mask = Image.new("L", (pw, ph), 0)
    mask.paste(255, (feather, feather, pw - feather, ph - feather))
    mask = mask.filter(ImageFilter.GaussianBlur(feather / 2))
    big.paste(orig, (px, py), mask)
    return big, "outpaint"


# ---------------------------------------------------------------- main
def main():
    os.makedirs(BG, exist_ok=True)
    history = load_history()
    arts = fetch_gdelt()
    log("gdelt articles:", len(arts))
    cands = candidates(arts, history)
    log("candidates:", len(cands))
    if not cands:
        log("nothing usable today; leaving current backdrop in place")
        return 0
    order = []
    i = llm_pick(cands)
    if i is not None:
        order.append(i)
    order += [k for k in range(len(cands)) if k not in order]
    # look at the actual photos of the top few and favour the long view: the pick is
    # the highest vista score (headline order breaks ties); if the vision model is
    # unreachable, the first downloadable photo in headline order wins as before
    looked = []          # (vista, -rank, k, photo)
    for rank, k in enumerate(order[:(16 if POOL_MODE else VISION_N)]):
        try:
            im = download_image(cands[k]["image"])
        except Exception as e:
            log("image failed for", cands[k]["domain"], e)
            continue
        v = vista_score(im)
        log("vista %s  %.0fx%.0f  [%s] %s" % ("-" if v is None else v, im.width, im.height,
                                             cands[k]["domain"], cands[k]["title"][:70]))
        looked.append((-1.0 if v is None else v, -rank, k, im))
        if v is None and len(looked) >= 3 and all(x[0] < 0 for x in looked):
            break            # model is down — no point downloading the rest
    if not looked:
        log("no downloadable image; keeping current backdrop")
        return 0
    looked.sort(key=lambda x: (x[0] if x[0] >= 0 else -1, x[1]), reverse=True)
    if POOL_MODE:
        return pool_run(cands, looked)
    v, _, k, photo = looked[0]
    if 0 <= v < VISTA_MIN:
        log("best vista only %.0f — nothing wide today, taking it anyway" % v)
    pick = cands[k]
    log("PICK:", pick["title"], "|", pick["url"])
    out, method = outpaint(photo, pick["title"])
    # The wall's day turns over at 03:33 America/New_York (the page does the flip on
    # each viewer's clock). This job runs at 02:33 NY, so "today" NY is the day this
    # backdrop becomes active; until 03:33 the page keeps showing prev.*.
    from zoneinfo import ZoneInfo
    ny = dt.datetime.now(ZoneInfo("America/New_York"))
    today = ny.strftime("%Y-%m-%d")
    active_at = ny.replace(hour=3, minute=33, second=0, microsecond=0).isoformat(timespec="seconds")
    cur_json = os.path.join(BG, "current.json")
    cur_jpg = os.path.join(BG, "current.jpg")
    prev_meta = None
    try:
        prev_meta = json.load(open(cur_json, encoding="utf-8"))
    except (OSError, ValueError):
        pass
    if prev_meta and prev_meta.get("id") != today and os.path.exists(cur_jpg):
        # keep yesterday's backdrop around so the page can show it until 03:33
        import shutil
        shutil.copyfile(cur_jpg, os.path.join(BG, "prev.jpg"))
        prev_meta = dict(prev_meta, image="prev.jpg?v=" + str(prev_meta.get("id")))
        json.dump(prev_meta, open(os.path.join(BG, "prev.json"), "w", encoding="utf-8"), indent=1)
    out.save(cur_jpg, "JPEG", quality=82, optimize=True, progressive=True)
    meta = {"id": today, "image": "current.jpg?v=" + today, "activeAt": active_at,
            "headline": pick["title"],
            "url": pick["url"], "outlet": pick["domain"].replace("www.", ""),
            "seendate": pick["seendate"], "method": method,
            "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    json.dump(meta, open(cur_json, "w", encoding="utf-8"), indent=1)
    history.append({k: meta[k] for k in ("id", "headline", "url", "outlet", "method")})
    json.dump(history[-120:], open(os.path.join(BG, "history.json"), "w", encoding="utf-8"), indent=1)
    log("wrote bg/current.jpg (%s) + current.json" % method)
    # ---- pool: today's pick plus the next-best two photos, kept for ~POOL_KEEP days,
    # so the wall's "Fresh news" button can swap in a different backdrop instantly
    # (the page picks one at random from bg/pool.json; no job needed).
    update_pool(today, meta, out, [(cands[kk], im) for _, _, kk, im in looked[1:3]])
    return 0


POOL_KEEP = 18
POOL_MIN_VISTA = 7


def pool_run(cands, looked):
    """--pool: add up to 3 wide, mutually different scenes to the pool; current.* untouched."""
    from zoneinfo import ZoneInfo
    stamp = dt.datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d-%H%M")
    pool = load_pool()
    used = topic_words([p.get("headline") for p in pool])
    hashes = [p.get("hash") for p in pool if p.get("hash")]
    added = []
    for v, _, k, im in looked:
        if len(added) >= 3:
            break
        if v < POOL_MIN_VISTA:   # unscored (vision down) counts as not wide enough
            continue
        c = cands[k]
        tw = topic_words([c["title"]])
        if tw & used:
            log("pool skip (same place/story):", c["title"][:60])
            continue
        h = ahash(im)
        if any(hamming(h, x) <= 6 for x in hashes):
            log("pool skip (same photo):", c["title"][:60])
            continue
        used |= tw
        hashes.append(h)
        pid = "%s-%d" % (stamp, len(added))
        cover(im, 1728, 972).save(os.path.join(BG, "pool-" + pid + ".jpg"), "JPEG", quality=80, optimize=True, progressive=True)
        added.append({"id": pid, "image": "pool-" + pid + ".jpg", "headline": c["title"], "url": c["url"],
                      "outlet": c["domain"].replace("www.", ""), "t": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                      "vista": v, "hash": h})
        log("pool +", "%.0f" % v, c["title"][:70])
    if not added:
        log("pool: nothing wide and new this run")
        return 0
    write_pool(pool + added)
    return 0


def write_pool(pool):
    pool = pool[-POOL_KEEP:]
    keep = {p["image"] for p in pool}
    for f in os.listdir(BG):
        if f.startswith("pool-") and f.endswith(".jpg") and f not in keep:
            os.remove(os.path.join(BG, f))
    json.dump(pool, open(os.path.join(BG, "pool.json"), "w", encoding="utf-8"), indent=1)
    log("pool: %d backdrops" % len(pool))


def update_pool(today, meta, primary, extras):
    pool_dir = BG  # flat files bg/pool-<id>.jpg (the GitHub upload page can't make new dirs)
    pool = load_pool()
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    entries = [{"id": today, "image": "pool-" + today + ".jpg", "headline": meta["headline"],
                "url": meta["url"], "outlet": meta["outlet"], "t": now, "hash": ahash(primary)}]
    primary.resize((1728, 972), Image.LANCZOS).save(os.path.join(pool_dir, "pool-" + today + ".jpg"),
                                                    "JPEG", quality=80, optimize=True, progressive=True)
    for i, (cand, im) in enumerate(extras):
        pid = "%s-%s" % (today, "bc"[i])
        cover(im, 1728, 972).save(os.path.join(pool_dir, "pool-" + pid + ".jpg"), "JPEG", quality=80, optimize=True, progressive=True)
        entries.append({"id": pid, "image": "pool-" + pid + ".jpg", "headline": cand["title"],
                        "url": cand["url"], "outlet": cand["domain"].replace("www.", ""), "t": now, "hash": ahash(im)})
    write_pool([p for p in pool if p["id"] != today and not p["id"].startswith(today + "-")
                or re.match(r"\d{4}-\d\d-\d\d-\d{4}-", p["id"])] + entries)


if __name__ == "__main__":
    sys.exit(main())
