/* graff wall — "Subject" selection for the Clone tool.
   A module worker: loads a small Segment Anything model (SlimSAM, ~15MB, cached by the
   browser after the first time) through Transformers.js and turns click points on a
   picture of the wall into a cutout mask. It only loads when someone picks Subject.

   in : { type:"image",  id, w, h, data:ArrayBuffer(RGBA) }      → the picture to look at
        { type:"points", id, seq, pts:[x,y,…], labels:[1|0,…] }  → clicks (1 = this, 0 = not this)
   out: { type:"status", id, msg } · { type:"ready", id }
        { type:"mask", id, seq, w, h, mask:ArrayBuffer(1 byte/px, 0|1), score }
        { type:"error", id, msg }

   Also does "No background" for the place bar (a second model, RMBG-1.4, ~45MB,
   loaded only when that box is first ticked):
   in : { type:"cutout", id, w, h, data:ArrayBuffer(RGBA) }
   out: { bg:1, type:"status", id, msg } · { bg:1, type:"alpha", id, w, h, alpha:ArrayBuffer(1 byte/px, 0–255) }
        { bg:1, type:"error", id, msg } */
const LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js";
const MODEL = "Xenova/slimsam-77-uniform";

let T = null, model = null, processor = null, loading = null;
let cur = null; /* { id, inputs, emb } for the picture being worked on */

function load(id) {
  if (!loading) loading = (async () => {
    T = await import(LIB);
    const seen = {};
    const progress = (p) => {
      if (p.status !== "progress" || !p.total || !/\.onnx/.test(p.file || "")) return;
      seen[p.file] = [p.loaded, p.total];
      let a = 0, b = 0;
      for (const k in seen) { a += seen[k][0]; b += seen[k][1]; }
      postMessage({ type: "status", id, msg: "downloading the subject finder… " + Math.round(100 * a / b) + "% (first time only)" });
    };
    model = await T.SamModel.from_pretrained(MODEL, { device: "wasm", dtype: "q8", progress_callback: progress });
    processor = await T.AutoProcessor.from_pretrained(MODEL);
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

const BG_MODEL = "briaai/RMBG-1.4";
let lib = null, bgPipe = null;
function loadBg(id) {
  if (!bgPipe) bgPipe = (async () => {
    if (!lib) lib = import(LIB);
    const TT = await lib;
    const seen = {};
    const progress = (p) => {
      if (p.status !== "progress" || !p.total || !/\.onnx/.test(p.file || "")) return;
      seen[p.file] = [p.loaded, p.total];
      let a = 0, b = 0;
      for (const k in seen) { a += seen[k][0]; b += seen[k][1]; }
      postMessage({ bg: 1, type: "status", id, msg: "downloading the background remover… " + Math.round(100 * a / b) + "% (first time only)" });
    };
    /* not the "background-removal" pipeline: in this library version it rejects this
       model's declared type, so load it as a plain model with the processor settings spelled out */
    const model = await TT.AutoModel.from_pretrained(BG_MODEL, { config: { model_type: "custom" }, device: "wasm", dtype: "q8", progress_callback: progress });
    const processor = await TT.AutoProcessor.from_pretrained(BG_MODEL, { config: {
      do_normalize: true, do_pad: false, do_rescale: true, do_resize: true,
      image_mean: [0.5, 0.5, 0.5], image_std: [1, 1, 1], feature_extractor_type: "ImageFeatureExtractor",
      resample: 2, rescale_factor: 0.00392156862745098, size: { width: 1024, height: 1024 } } });
    return { TT, model, processor };
  })().catch((e) => { bgPipe = null; throw e; });
  return bgPipe;
}
async function cutout(m) {
  try {
    postMessage({ bg: 1, type: "status", id: m.id, msg: "loading the background remover…" });
    const { TT, model, processor } = await loadBg(m.id);
    postMessage({ bg: 1, type: "status", id: m.id, msg: "cutting out the subject… (a few seconds)" });
    const img = new TT.RawImage(new Uint8ClampedArray(m.data), m.w, m.h, 4).rgb();
    const { pixel_values } = await processor(img);
    const { output } = await model({ input: pixel_values });
    const matte = await TT.RawImage.fromTensor(output[0].mul(255).to("uint8")).resize(m.w, m.h);
    if (!matte || matte.width * matte.height !== matte.data.length) throw new Error("no matte came back");
    const alpha = new Uint8Array(matte.data);
    postMessage({ bg: 1, type: "alpha", id: m.id, w: matte.width, h: matte.height, alpha: alpha.buffer }, [alpha.buffer]);
  } catch (err) {
    postMessage({ bg: 1, type: "error", id: m.id, msg: String((err && err.message) || err).slice(0, 140) });
  }
}

/* one job at a time, in order */
let chain = Promise.resolve();
onmessage = (e) => { chain = chain.then(() => handle(e.data)); };

async function handle(m) {
  if (m.type === "cutout") return cutout(m);
  try {
    if (m.type === "image") {
      cur = null;
      postMessage({ type: "status", id: m.id, msg: "loading the subject finder…" });
      await load(m.id);
      postMessage({ type: "status", id: m.id, msg: "looking at the wall…" });
      const img = new T.RawImage(new Uint8ClampedArray(m.data), m.w, m.h, 4).rgb();
      const inputs = await processor(img);
      const emb = await model.get_image_embeddings(inputs);
      cur = { id: m.id, inputs, emb, w: m.w, h: m.h };
      postMessage({ type: "ready", id: m.id });
    } else if (m.type === "points") {
      if (!cur || cur.id !== m.id) return;
      const n = m.labels.length;
      const [rh, rw] = cur.inputs.reshaped_input_sizes[0];
      const [oh, ow] = cur.inputs.original_sizes[0];
      const pts = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        pts[2 * i] = m.pts[2 * i] * rw / ow;
        pts[2 * i + 1] = m.pts[2 * i + 1] * rh / oh;
      }
      const input_points = new T.Tensor("float32", pts, [1, 1, n, 2]);
      const input_labels = new T.Tensor("int64", BigInt64Array.from(m.labels, (v) => BigInt(v)), [1, 1, n]);
      const out = await model({ ...cur.emb, input_points, input_labels });
      const masks = await processor.post_process_masks(out.pred_masks, cur.inputs.original_sizes, cur.inputs.reshaped_input_sizes);
      const t = masks[0];                       /* [1, k, h, w] of 0|1 */
      const k = t.dims[1], h = t.dims[2], w = t.dims[3];
      const sc = out.iou_scores.data;
      let best = 0;
      for (let i = 1; i < k; i++) if (sc[i] > sc[best]) best = i;
      const mask = new Uint8Array(w * h);
      mask.set(t.data.subarray(best * w * h, (best + 1) * w * h));
      postMessage({ type: "mask", id: m.id, seq: m.seq, w, h, mask: mask.buffer, score: Number(sc[best]) }, [mask.buffer]);
    }
  } catch (err) {
    postMessage({ type: "error", id: m.id, msg: String((err && err.message) || err).slice(0, 140) });
  }
}
