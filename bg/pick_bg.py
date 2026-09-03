#!/usr/bin/env python3
"""
Daily news backdrop for the graffiti wall.

Runs from .github/workflows/daily-bg.yml. Steps:
  1. Pull the last 10 days of English headlines from GDELT (free, keyless),
     biased toward disasters / emergencies / catastrophes / scandals.
  2. Ask the Pollinations text model to pick the single most striking story
     with a usable photo (heuristic fallback if that fails).
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

QUERY = ('(flood OR earthquake OR wildfire OR hurricane OR typhoon OR cyclone OR eruption '
         'OR explosion OR collapse OR derailment OR "plane crash" OR "state of emergency" '
         'OR evacuation OR "dam breach" OR "glacial lake" OR landslide OR tsunami OR outbreak '
         'OR blackout OR "oil spill" OR scandal OR resigns OR indicted OR riot OR "breaking news") '
         'sourcelang:eng')
GOOD_DOMAINS = ("reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "theguardian.com",
                "aljazeera.com", "npr.org", "cnn.com", "nytimes.com", "washingtonpost.com",
                "france24.com", "dw.com", "abc.net.au", "cbc.ca", "nbcnews.com", "cbsnews.com",
                "abcnews.go.com", "euronews.com", "kathmandupost.com", "scmp.com", "latimes.com")
BAD_WORDS = ("opinion", "explainer", "podcast", "live updates", "how to", "quiz", "horoscope")
DISASTER_WORDS = ("flood", "quake", "fire", "hurricane", "typhoon", "cyclone", "erupt", "explo",
                  "collaps", "crash", "emergency", "evacuat", "breach", "landslide", "tsunami",
                  "outbreak", "blackout", "spill", "dead", "killed", "destroy", "scandal", "indict")


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


# ---------------------------------------------------------------- 1. headlines
def fetch_gdelt():
    url = ("https://api.gdeltproject.org/api/v2/doc/doc?" + urllib.parse.urlencode({
        "query": QUERY, "mode": "ArtList", "format": "json", "maxrecords": 120,
        "timespan": "10d", "sort": "DateDesc"}))
    for attempt in range(3):
        try:
            r = requests.get(url, headers=UA, timeout=40)
            r.raise_for_status()
            arts = r.json().get("articles", [])
            if arts:
                return arts
        except Exception as e:
            log("gdelt attempt", attempt, e)
        time.sleep(5)
    return []


def load_history():
    try:
        return json.load(open(os.path.join(BG, "history.json"), encoding="utf-8"))
    except Exception:
        return []


def candidates(arts, history):
    seen_urls = {h.get("url") for h in history[-30:]}
    seen_heads = {(h.get("headline") or "").lower()[:40] for h in history[-30:]}
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
        if any(dom.endswith(g) for g in GOOD_DOMAINS):
            score += 3
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
    prompt = ("You choose one news story per day whose photo becomes the backdrop of a public "
              "graffiti wall. Prefer, in order: disasters, emergencies, catastrophes, scandals, "
              "breaking news — the more dramatic and photographable the better. Avoid opinion "
              "pieces and stories without a clear physical scene.\n\nStories:\n" + listing +
              "\n\nReply with ONLY the number of your pick.")
    try:
        r = requests.post("https://text.pollinations.ai/openai",
                          headers={"Content-Type": "application/json",
                                   **({"Authorization": "Bearer " + KEY} if KEY else {})},
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
              "had a wider lens. Keep every original photo pixel exactly unchanged. No text, "
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
    photo = pick = None
    for k in order[:8]:
        try:
            photo = download_image(cands[k]["image"])
            pick = cands[k]
            break
        except Exception as e:
            log("image failed for", cands[k]["domain"], e)
    if photo is None:
        log("no downloadable image; keeping current backdrop")
        return 0
    log("PICK:", pick["title"], "|", pick["url"])
    out, method = outpaint(photo, pick["title"])
    today = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    out.save(os.path.join(BG, "current.jpg"), "JPEG", quality=82, optimize=True, progressive=True)
    meta = {"id": today, "image": "current.jpg?v=" + today, "headline": pick["title"],
            "url": pick["url"], "outlet": pick["domain"].replace("www.", ""),
            "seendate": pick["seendate"], "method": method,
            "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    json.dump(meta, open(os.path.join(BG, "current.json"), "w", encoding="utf-8"), indent=1)
    history.append({k: meta[k] for k in ("id", "headline", "url", "outlet", "method")})
    json.dump(history[-120:], open(os.path.join(BG, "history.json"), "w", encoding="utf-8"), indent=1)
    log("wrote bg/current.jpg (%s) + current.json" % method)
    return 0


if __name__ == "__main__":
    sys.exit(main())
