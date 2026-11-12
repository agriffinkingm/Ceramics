/* graff wall — "Subject" selection for the Clone tool.
   A module worker: loads a small Segment Anything model (SlimSAM, ~15MB, cached by the
   browser after the first time) through Transformers.js and turns click points on a
   picture of the wall into a cutout mask. It only loads when someone picks Subject.

   in : { type:"image",  id, w, h, data:ArrayBuffer(RGBA) }      → the picture to look at
        { type:"points", id, seq, pts:[x,y,…], labels:[1|0,…] }  → clicks (1 = this, 0 = not this)
   out: { type:"status", id, msg } · { type:"ready", id }
        { type:"mask", id, seq, w, h, mask:ArrayBuffer(1 byte/px, 0|1), score }
        { type:"error", id, msg } */
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

/* one job at a time, in order */
let chain = Promise.resolve();
onmessage = (e) => { chain = chain.then(() => handle(e.data)); };

async function handle(m) {
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
