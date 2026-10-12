// Converts 4K (or very large) phone videos to 1080p MP4 in the browser, using the phone's own
// video hardware through WebCodecs (via the Mediabunny library, loaded only when needed).
// The original file is never changed; only the copy that goes into the app is smaller.
import { fmtDur } from './util.js';

export const MAX_UPLOAD = 95 * 1024 * 1024; // GitHub accepts files up to 100 MB
const TARGET_BYTES = 90 * 1024 * 1024;      // aim a bit lower, VBR can overshoot

let lib = null;
const load = () => (lib ||= import('../vendor/mediabunny.min.mjs'));

export const canConvert = () => typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';

function openInput(M, file) {
  return new M.Input({ source: new M.BlobSource(file), formats: M.ALL_FORMATS });
}

/** Read resolution and duration without decoding. Returns null if the file can't be parsed. */
export async function inspect(file) {
  try {
    const M = await load();
    const input = openInput(M, file);
    try {
      const [v] = await input.getVideoTracks();
      if (!v) return null;
      return { width: v.displayWidth, height: v.displayHeight, dur: await input.computeDuration(), codec: v.codec };
    } finally {
      input.dispose?.();
    }
  } catch (e) {
    console.warn('inspect failed', e);
    return null;
  }
}

/** 4K and anything over the upload limit gets converted. */
export function shouldConvert(info, size) {
  if (!info) return false;
  return Math.min(info.width, info.height) > 1080 || size > MAX_UPLOAD;
}

/** Choose output size and bitrate so the result looks good and stays under the limit. */
function plan(info, fps, audioBps) {
  const budget = (TARGET_BYTES * 8) / Math.max(info.dur, 1) - audioBps; // bits/s left for video
  const hiFps = fps > 35;
  let short = 1080;
  let bitrate = Math.min(hiFps ? 9_000_000 : 6_000_000, budget * 0.92);
  if (bitrate < 2_500_000) {
    short = 720;
    bitrate = Math.min(hiFps ? 5_000_000 : 3_500_000, budget * 0.92);
  }
  if (bitrate < 900_000) {
    throw new Error(`clipul e prea lung (${fmtDur(info.dur)}) ca să încapă sub 100 MB. Taie-l în bucăți de cel mult 8 minute.`);
  }
  short = Math.min(short, Math.min(info.width, info.height)); // never upscale
  return { short, bitrate: Math.round(bitrate) };
}

/**
 * Convert to 1080p (or 720p for very long clips). Sound is copied unchanged when possible.
 * Resolves to {blob, width, height, codec, bitrate}.
 */
export async function convert(file, { onProgress } = {}) {
  if (!canConvert()) throw new Error('browserul acesta nu poate converti video');
  const M = await load();
  let attempt = 0, scale = 1;
  for (;;) {
    const input = openInput(M, file);
    try {
      const [v] = await input.getVideoTracks();
      if (!v) throw new Error('fișierul nu conține video');
      const [a] = await input.getAudioTracks();
      const info = { width: v.displayWidth, height: v.displayHeight, dur: await input.computeDuration() };
      let fps = 30;
      try { fps = (await v.computeFrameRateMetrics()).averageFrameRate || 30; } catch {}
      let audioBps = 0;
      if (a) {
        try { audioBps = (await a.computePacketStats(200)).averageBitrate || 192_000; } catch { audioBps = 192_000; }
      }
      const p = plan(info, fps, audioBps);
      const bitrate = Math.round(p.bitrate * scale);
      const portrait = info.height > info.width;
      const size = portrait ? { width: p.short } : { height: p.short };
      const outW = portrait ? p.short : Math.round((info.width / info.height) * p.short / 2) * 2;
      const outH = portrait ? Math.round((info.height / info.width) * p.short / 2) * 2 : p.short;
      const codec = await M.getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: outW, height: outH, bitrate });
      if (!codec) throw new Error('telefonul nu are un codec video potrivit pentru conversie');

      const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new M.BufferTarget() });
      const conversion = await M.Conversion.init({
        input,
        output,
        tracks: 'primary',
        video: { ...size, codec, quality: new M.Quality({ bitrate, bitrateMode: 'variable' }), keyFrameInterval: 2, forceTranscode: true },
        audio: a && ['aac', 'opus', 'mp3'].includes(a.codec) ? {} : { codec: 'aac', quality: new M.Quality({ bitrate: 160_000 }) },
      });
      if (!conversion.isValid) {
        throw new Error('conversia nu e posibilă (' + conversion.discardedTracks.map((t) => t.reason).join(', ') + ')');
      }
      if (a && conversion.discardedTracks.some((t) => t.track === a)) {
        throw new Error('sunetul nu poate fi convertit pe acest dispozitiv');
      }
      conversion.onProgress = (pr) => onProgress?.(Math.min(1, pr));
      await conversion.execute();
      const buf = output.target.buffer;
      if (buf.byteLength > MAX_UPLOAD && attempt < 2) { attempt++; scale *= 0.75; continue; } // overshoot: retry smaller
      if (buf.byteLength > MAX_UPLOAD) throw new Error('rezultatul a ieșit tot peste 100 MB');
      return { blob: new Blob([buf], { type: 'video/mp4' }), width: outW, height: outH, codec, bitrate };
    } finally {
      input.dispose?.();
    }
  }
}
