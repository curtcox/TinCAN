/**
 * Rig descriptions — spec/rig.md.
 *
 * A description is versioned JSON that says what a device should play, record
 * and measure on a shared clock. This module is the whole interpreter: it
 * validates a description (rejecting anything outside the DSL, since a page
 * runs descriptions, not code), renders its play actions into one signal, and
 * summarizes recordings. It stays free of any DOM or Web Audio reference so
 * that it runs identically in a page and in the test suite.
 */

import {
  BANDS, PROFILES, DETECTOR_DEFAULTS, NYQUIST_USE, timing, minTqMs,
} from './params.js';
import { buildTransmission } from './frame.js';
import { mulberry32 } from './bus.js';

/** Hard limits, so no description can blast a speaker — spec/rig.md §5. */
export const LIMITS = {
  maxLevel: 0.5,
  maxSeconds: 120,
  maxActions: 64,
  maxRepeat: 64,
  maxDepth: 2,
};

/** The action names a description may use. */
export const ACTIONS = ['tone', 'chirp', 'noise', 'silence', 'frame', 'record', 'measure', 'node', 'repeat'];

const RETURN_KINDS = ['wav', 'levels', 'goertzel', 'spectrum', 'edges'];
const MEASURE_KINDS = ['latency', 'noise', 'clock', 'audio'];
const NODE_OPS = ['join', 'send', 'stats', 'bandtest', 'leave'];

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);

// Every key a kind of action may carry. `measure` and `index` are nowhere in
// the lists: they mark expanded measure actions (see `expand`) and are the
// interpreter's own, so a description that carries them is rejected.
const KEYS = {
  tone: ['do', 't', 'band', 'which', 'hz', 'level', 'seconds', 'ramp'],
  chirp: ['do', 't', 'from', 'to', 'seconds', 'level', 'ramp'],
  noise: ['do', 't', 'color', 'seconds', 'level', 'seed'],
  silence: ['do', 't', 'seconds'],
  frame: ['do', 't', 'band', 'profile', 'frame', 'level', 'errors'],
  record: ['do', 't', 'seconds', 'return', 'hz', 'window', 'band', 'thetaD', 'floor', 'bins'],
  measure: ['do', 't', 'what'],
  node: ['do', 't', 'op', 'band', 'profile', 'address', 'callsign', 'level', 'thetaD', 'kappa', 'frame', 'bands', 'window'],
  repeat: ['do', 't', 'times', 'every', 'actions'],
};

const num = (v, d) => (v === undefined ? d : v);

function checkUnknownKeys(a, path, errors) {
  for (const k of Object.keys(a)) {
    if (!KEYS[a.do].includes(k)) errors.push(`${path}.${k}: unknown key`);
  }
}

function checkSeconds(a, path, errors, d) {
  const s = num(a.seconds, d);
  if (!isNum(s) || s <= 0) errors.push(`${path}.seconds: must be a number above 0`);
  return s;
}

function checkLevel(a, path, errors, d = 0.25) {
  const level = num(a.level, d);
  if (!isNum(level) || level < 0) errors.push(`${path}.level: must be a number at or above 0`);
  else if (level > LIMITS.maxLevel) errors.push(`${path}.level: ${level} is above the limit of ${LIMITS.maxLevel}`);
  return level;
}

function checkBand(a, path, errors, need) {
  if (!(a.band in BANDS)) { errors.push(`${path}.band: unknown band ${JSON.stringify(a.band)}`); return null; }
  if (need) {
    for (const k of need) if (a[k] === undefined) errors.push(`${path}.${k}: required`);
  }
  return a.band;
}

/** A {id, data, extended?, rtr?} object, normalized with data a plain array. */
function checkFrameObject(f, path, errors) {
  if (typeof f !== 'object' || f === null || Array.isArray(f)) {
    errors.push(`${path}: must be an object`);
    return null;
  }
  const out = { id: f.id, data: f.data };
  if (f.extended) out.extended = true;
  if (f.rtr) out.rtr = true;
  for (const k of Object.keys(f)) {
    if (!['id', 'data', 'extended', 'rtr'].includes(k)) errors.push(`${path}.${k}: unknown key`);
  }
  if (!isInt(out.id) || out.id < 0 || out.id > 0x1fffffff || (!out.extended && out.id > 0x7ff)) {
    errors.push(`${path}.id: must be an integer 11-bit${out.extended ? ' or 29-bit' : ''} identifier`);
  }
  if (typeof out.data === 'string') {
    if (!/^[0-9a-fA-F]*$/.test(out.data) || out.data.length % 2 || out.data.length > 128) {
      errors.push(`${path}.data: hex string, even length, at most 64 octets`);
    } else {
      out.data = out.data.match(/../g)?.map((h) => parseInt(h, 16)) ?? [];
    }
  } else if (Array.isArray(out.data)) {
    if (out.data.length > 64 || out.data.some((b) => !isInt(b) || b < 0 || b > 255)) {
      errors.push(`${path}.data: an array of octets, at most 64`);
    }
  } else {
    errors.push(`${path}.data: a hex string or an array of octets`);
    out.data = [];
  }
  return out;
}

/** The transmission's bits after `errors` are applied, or null on failure. */
function frameBits(f, errors) {
  try {
    let bits = buildTransmission(f).bits;
    if (errors?.flip) bits = bits.map((b, i) => (errors.flip.includes(i) ? b ^ 1 : b));
    if (errors?.cut !== undefined) bits = bits.slice(0, errors.cut);
    return bits;
  } catch {
    return null;
  }
}

/** Duration of one action in seconds, repeats expanded. */
function duration(a) {
  switch (a.do) {
    case 'tone': case 'chirp': case 'noise': case 'silence': case 'record':
      return a.seconds ?? 0;
    case 'frame': {
      if (!a.frame || !(a.profile in PROFILES)) return 0;
      const bits = frameBits(a.frame, a.errors);
      return bits ? bits.length * timing(a.profile).bitTime : 0;
    }
    case 'measure':
      return a.what === 'latency' || a.what === 'noise' ? 1.0 : 0;
    case 'node':
      return 0;
    case 'repeat': {
      const inner = Math.max(0, ...(a.actions ?? []).map((x) => (x.t ?? 0) + duration(x)));
      return ((a.times ?? 1) - 1) * (a.every ?? 0) + inner;
    }
    default:
      return 0;
  }
}

function checkT(a, path, errors) {
  const t = num(a.t, 0);
  if (!isNum(t) || t < 0) errors.push(`${path}.t: must be a number at or above 0`);
  return t;
}

function checkActions(list, path, errors, depth) {
  if (!Array.isArray(list) || !list.length) {
    errors.push(`${path}: a non-empty array of actions`);
    return [];
  }
  if (list.length > LIMITS.maxActions) {
    errors.push(`${path}: ${list.length} actions is above the limit of ${LIMITS.maxActions}`);
  }
  return list.map((a, i) => checkAction(a, `${path}[${i}]`, errors, depth));
}

function checkAction(a, path, errors, depth) {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) {
    errors.push(`${path}: must be an object`);
    return { do: 'silence', t: 0, seconds: 1e-9 };
  }
  if (!ACTIONS.includes(a.do)) {
    errors.push(`${path}.do: unknown action ${JSON.stringify(a.do)}`);
    return { do: 'silence', t: checkT(a, path, errors), seconds: 1e-9 };
  }
  checkUnknownKeys(a, path, errors);
  const out = { do: a.do, t: checkT(a, path, errors) };

  switch (a.do) {
    case 'tone': {
      if (a.hz === undefined) {
        const band = checkBand(a, path, errors, ['which']);
        if (a.which !== undefined && a.which !== 'R' && a.which !== 'D') {
          errors.push(`${path}.which: "R" or "D"`);
        }
        if (band && (a.which === 'R' || a.which === 'D')) {
          out.band = band;
          out.which = a.which;
        }
      } else {
        if (a.band !== undefined || a.which !== undefined) {
          errors.push(`${path}: either band/which or hz, not both`);
        }
        if (!isNum(a.hz) || a.hz <= 0) errors.push(`${path}.hz: must be a number above 0`);
        else out.hz = a.hz;
      }
      out.level = checkLevel(a, path, errors);
      out.seconds = checkSeconds(a, path, errors, 0.5);
      out.ramp = num(a.ramp, 0.01);
      if (!isNum(out.ramp) || out.ramp < 0) errors.push(`${path}.ramp: must be a number at or above 0`);
      break;
    }
    case 'chirp': {
      for (const k of ['from', 'to']) {
        if (!isNum(a[k]) || a[k] <= 0) errors.push(`${path}.${k}: must be a number above 0`);
        else out[k] = a[k];
      }
      out.seconds = checkSeconds(a, path, errors, 0.1);
      out.level = checkLevel(a, path, errors);
      if (a.ramp !== undefined) {
        out.ramp = a.ramp;
        if (!isNum(a.ramp) || a.ramp < 0) errors.push(`${path}.ramp: must be a number at or above 0`);
      }
      break;
    }
    case 'noise': {
      out.color = num(a.color, 'white');
      if (out.color !== 'white' && out.color !== 'pink') errors.push(`${path}.color: "white" or "pink"`);
      out.seconds = checkSeconds(a, path, errors, 0.5);
      out.level = checkLevel(a, path, errors);
      out.seed = num(a.seed, 1);
      if (!isInt(out.seed)) errors.push(`${path}.seed: must be an integer`);
      break;
    }
    case 'silence':
      out.seconds = checkSeconds(a, path, errors);
      break;
    case 'frame': {
      out.band = checkBand(a, path, errors, ['profile', 'frame']);
      if (a.profile !== undefined && !(a.profile in PROFILES)) {
        errors.push(`${path}.profile: unknown profile ${JSON.stringify(a.profile)}`);
      } else if (a.profile !== undefined) {
        out.profile = a.profile;
      }
      if (out.band && out.profile && PROFILES[out.profile].tqMs < minTqMs(out.band)) {
        errors.push(`${path}: profile ${out.profile} is too fast for band ${out.band}`);
      }
      out.level = checkLevel(a, path, errors);
      if (a.frame !== undefined) out.frame = checkFrameObject(a.frame, `${path}.frame`, errors);
      if (a.errors !== undefined) {
        const e = a.errors;
        if (typeof e !== 'object' || e === null || Array.isArray(e)) {
          errors.push(`${path}.errors: must be an object`);
        } else {
          for (const k of Object.keys(e)) {
            if (!['flip', 'cut'].includes(k)) errors.push(`${path}.errors.${k}: unknown key`);
          }
          out.errors = {};
          if (e.flip !== undefined) {
            if (!Array.isArray(e.flip) || e.flip.some((i) => !isInt(i))) {
              errors.push(`${path}.errors.flip: an array of bit indices`);
            } else out.errors.flip = e.flip;
          }
          if (e.cut !== undefined) {
            if (!isInt(e.cut) || e.cut < 1) errors.push(`${path}.errors.cut: a bit count, at least 1`);
            else out.errors.cut = e.cut;
          }
        }
      }
      if (out.frame && out.errors) {
        const total = frameBits(out.frame, null)?.length ?? 0;
        for (const i of out.errors.flip ?? []) {
          if (i < 0 || i >= total) errors.push(`${path}.errors.flip: bit ${i} out of range (0..${total - 1})`);
        }
        if (out.errors.cut !== undefined && out.errors.cut > total) {
          errors.push(`${path}.errors.cut: ${out.errors.cut} past the frame's ${total} bits`);
        }
      }
      break;
    }
    case 'record': {
      out.seconds = checkSeconds(a, path, errors);
      out.return = num(a.return, ['levels']);
      if (!Array.isArray(out.return) || out.return.some((r) => !RETURN_KINDS.includes(r))) {
        errors.push(`${path}.return: a subset of ${JSON.stringify(RETURN_KINDS)}`);
        out.return = ['levels'];
      } else {
        out.return = [...new Set(out.return)];
      }
      if (a.hz !== undefined) {
        if (!Array.isArray(a.hz) || a.hz.some((h) => !isNum(h) || h <= 0)) {
          errors.push(`${path}.hz: an array of frequencies`);
        } else out.hz = a.hz;
      }
      if (a.window !== undefined) {
        out.window = a.window;
        if (!isNum(a.window) || a.window <= 0) errors.push(`${path}.window: must be a number above 0`);
      }
      if (a.band !== undefined) {
        if (!(a.band in BANDS)) errors.push(`${path}.band: unknown band ${JSON.stringify(a.band)}`);
        else out.band = a.band;
      }
      if (a.thetaD !== undefined) {
        out.thetaD = a.thetaD;
        if (!isNum(a.thetaD) || a.thetaD <= 0 || a.thetaD >= 1) errors.push(`${path}.thetaD: a fraction in (0,1)`);
      }
      if (a.floor !== undefined) {
        out.floor = a.floor;
        if (!isNum(a.floor) || a.floor < 0) errors.push(`${path}.floor: must be a number at or above 0`);
      }
      if (a.bins !== undefined) {
        out.bins = a.bins;
        if (!isInt(a.bins) || a.bins < 1) errors.push(`${path}.bins: an integer, at least 1`);
      }
      break;
    }
    case 'measure':
      if (!MEASURE_KINDS.includes(a.what)) {
        errors.push(`${path}.what: one of ${JSON.stringify(MEASURE_KINDS)}`);
      } else out.what = a.what;
      break;
    case 'node': {
      if (!NODE_OPS.includes(a.op)) {
        errors.push(`${path}.op: one of ${JSON.stringify(NODE_OPS)}`);
        break;
      }
      out.op = a.op;
      if (a.op === 'join') {
        out.band = checkBand(a, path, errors, ['profile', 'address']);
        if (a.profile !== undefined && !(a.profile in PROFILES)) {
          errors.push(`${path}.profile: unknown profile ${JSON.stringify(a.profile)}`);
        } else if (a.profile !== undefined) out.profile = a.profile;
        if (out.band && out.profile && PROFILES[out.profile].tqMs < minTqMs(out.band)) {
          errors.push(`${path}: profile ${out.profile} is too fast for band ${out.band}`);
        }
        if (!isInt(a.address) || a.address < 0 || a.address > 30) {
          errors.push(`${path}.address: an integer node address, 0–30`);
        } else out.address = a.address;
        if (a.callsign !== undefined) {
          if (typeof a.callsign !== 'string' || a.callsign.length > 8) {
            errors.push(`${path}.callsign: at most 8 characters`);
          } else out.callsign = a.callsign;
        }
        if (a.level !== undefined) out.level = checkLevel(a, path, errors);
        if (a.thetaD !== undefined) {
          out.thetaD = a.thetaD;
          if (!isNum(a.thetaD) || a.thetaD <= 0 || a.thetaD >= 1) errors.push(`${path}.thetaD: a fraction in (0,1)`);
        }
        if (a.kappa !== undefined) {
          out.kappa = a.kappa;
          if (!isNum(a.kappa) || a.kappa <= 0) errors.push(`${path}.kappa: must be a number above 0`);
        }
      } else if (a.op === 'send') {
        if (a.frame === undefined) errors.push(`${path}.frame: required`);
        else out.frame = checkFrameObject(a.frame, `${path}.frame`, errors);
      } else if (a.op === 'bandtest') {
        if (!Array.isArray(a.bands) || !a.bands.length || a.bands.some((b) => !(b in BANDS))) {
          errors.push(`${path}.bands: a non-empty array of ${JSON.stringify(Object.keys(BANDS))}`);
        } else out.bands = [...a.bands];
        if (!isInt(a.window) || a.window < 1 || a.window > 255) {
          errors.push(`${path}.window: an integer 1–255`);
        } else out.window = a.window;
      }
      break;
    }
    case 'repeat': {
      if (depth >= LIMITS.maxDepth) {
        errors.push(`${path}: repeats nest at most ${LIMITS.maxDepth} deep`);
      }
      if (!isInt(a.times) || a.times < 1 || a.times > LIMITS.maxRepeat) {
        errors.push(`${path}.times: an integer 1–${LIMITS.maxRepeat}`);
      } else out.times = a.times;
      if (!isNum(a.every) || a.every <= 0) {
        errors.push(`${path}.every: must be a number above 0`);
      } else out.every = a.every;
      out.actions = checkActions(a.actions, `${path}.actions`, errors, depth + 1);
      break;
    }
    default:
  }
  return out;
}

/**
 * Check a description and return `{ ok, errors, desc }`: every problem found,
 * not just the first, and the description normalized with defaults filled.
 * `desc` stays JSON-safe (frame payloads are plain arrays).
 */
export function validate(desc) {
  const errors = [];
  const out = { rig: 1, actions: [] };
  if (typeof desc !== 'object' || desc === null || Array.isArray(desc)) {
    return { ok: false, errors: ['description: must be an object'], desc: out };
  }
  for (const k of Object.keys(desc)) {
    if (!['rig', 'name', 'at', 'actions'].includes(k)) errors.push(`${k}: unknown key`);
  }
  if (desc.rig !== 1) errors.push(`rig: must be 1`);
  if (desc.name !== undefined) {
    if (typeof desc.name !== 'string') errors.push('name: must be a string');
    else out.name = desc.name;
  }
  if (desc.at !== undefined) {
    if (!isNum(desc.at)) errors.push('at: server time in milliseconds since the Unix epoch');
    else out.at = desc.at;
  }
  out.actions = checkActions(desc.actions, 'actions', errors, 0);
  const s = span(out);
  if (s > LIMITS.maxSeconds) {
    errors.push(`description: span of ${s.toFixed(3)} s is above the limit of ${LIMITS.maxSeconds} s`);
  }
  return { ok: errors.length === 0, errors, desc: out };
}

/* ------------------------------------------------------------------ */
/* span and expansion                                                  */
/* ------------------------------------------------------------------ */

/**
 * Each leaf action with its absolute start in seconds, repeats unrolled:
 * `fn(action, tStart, index)`, `index` its position in its own array — the
 * number `expand` tags measure replacements with.
 */
export function eachAction(desc, fn) {
  const walk = (actions, base) => {
    actions.forEach((a, i) => {
      const t = base + (a.t ?? 0);
      if (a.do === 'repeat') {
        for (let k = 0; k < (a.times ?? 1); k++) walk(a.actions ?? [], t + k * (a.every ?? 0));
      } else {
        fn(a, t, i);
      }
    });
  };
  walk(desc.actions ?? [], 0);
}

/** The description's span: the latest end of any action, seconds. */
export function span(desc) {
  let end = 0;
  eachAction(desc, (a, t) => { end = Math.max(end, t + duration(a)); });
  return end;
}

/**
 * Replace each `latency`/`noise` measure action by the play and record actions
 * it stands for — spec/rig.md §3.3. The replacement actions carry `measure`
 * and `index` (the action's position in its array); both keys are internal and
 * a description that arrives with them fails validation. `clock` and `audio`
 * measures need no audio and pass through.
 */
export function expand(desc) {
  const widen = (actions) => actions.flatMap((a, i) => {
    if (a.do === 'measure' && a.what === 'latency') {
      return [
        { do: 'chirp', t: a.t, from: 2000, to: 5000, seconds: 0.05, level: 0.25, measure: 'latency', index: i },
        { do: 'record', t: a.t, seconds: 1.0, return: [], measure: 'latency', index: i },
      ];
    }
    if (a.do === 'measure' && a.what === 'noise') {
      return [{ do: 'record', t: a.t, seconds: 1.0, return: [], measure: 'noise', index: i }];
    }
    if (a.do === 'repeat') return [{ ...a, actions: widen(a.actions) }];
    return [a];
  });
  return { ...desc, actions: widen(desc.actions ?? []) };
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

const raisedCosine = (x) => 0.5 - 0.5 * Math.cos(Math.PI * x);

/** Raised-cosine onset and end, as bandtest.js testSignal shapes its tones. */
function edgeGain(i, n, ramp) {
  if (ramp <= 0) return 1;
  const edge = Math.min(i, n - 1 - i);
  return edge < ramp ? raisedCosine(edge / ramp) : 1;
}

/** A linear sweep, phased as probe.js chirp. Hann-enveloped unless `ramp` is set. */
export function chirpSignal(a, fs) {
  const n = Math.round(a.seconds * fs);
  const out = new Float32Array(n);
  const ramp = Math.round((a.ramp ?? 0) * fs);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const phase = 2 * Math.PI * (a.from * t + ((a.to - a.from) * t * t) / (2 * a.seconds));
    const g = a.ramp === undefined
      ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
      : edgeGain(i, n, ramp);
    out[i] = a.level * g * Math.sin(phase);
  }
  return out;
}

/** White noise, or Paul Kellet's economy pink filter over it, peak `level`. */
function noiseSignal(a, fs) {
  const n = Math.round(a.seconds * fs);
  const out = new Float32Array(n);
  const rnd = mulberry32(a.seed);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1;
    if (a.color === 'pink') {
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      out[i] = b0 + b1 + b2 + w * 0.1848;
    } else {
      out[i] = w;
    }
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < n; i++) out[i] *= a.level / peak;
  return out;
}

/**
 * A TinCAN frame as audio: 1 → f_R, 0 → f_D, one bit per bit time, two
 * phase-continuous oscillators with the Phy's 1 ms raised-cosine cross-fade —
 * including into and out of silence. `errors.flip` inverts bits, `errors.cut`
 * truncates the transmission.
 */
export function renderFrame(a, fs) {
  const bits = frameBits(a.frame, a.errors) ?? [];
  const { fR, fD } = BANDS[a.band];
  const incR = (2 * Math.PI * fR) / fs;
  const incD = (2 * Math.PI * fD) / fs;
  const bitN = Math.round(timing(a.profile).bitTime * fs);
  const switchSamples = Math.max(1, Math.round(0.001 * fs));
  const out = new Float32Array(bitN * bits.length);
  let phaseR = 0, phaseD = 0;
  let tx = null, prev = null, sw = switchSamples;

  const emit = (k) => {
    phaseR += incR; if (phaseR > 6.283185307179586) phaseR -= 6.283185307179586;
    phaseD += incD; if (phaseD > 6.283185307179586) phaseD -= 6.283185307179586;
    if (tx === null && prev === null) return 0;
    let gNew = 1, gOld = 0;
    if (sw < switchSamples) {
      const p = (sw + 1) / switchSamples;
      gNew = raisedCosine(p);
      gOld = 1 - gNew;
      sw++;
    }
    const tone = (lvl) => (lvl === null ? 0 : (lvl ? Math.sin(phaseR) : Math.sin(phaseD)));
    return a.level * (gNew * tone(tx) + gOld * tone(prev));
  };

  for (let b = 0; b < bits.length; b++) {
    const level = bits[b];
    if (level !== tx) { prev = tx; tx = level; sw = 0; }
    for (let i = 0; i < bitN; i++) out[b * bitN + i] = emit(b * bitN + i);
  }
  return out;
}

const frequenciesOf = (a) => {
  switch (a.do) {
    case 'tone': return [a.hz ?? (a.which === 'D' ? BANDS[a.band].fD : BANDS[a.band].fR)];
    case 'chirp': return [a.from, a.to];
    case 'frame': return [BANDS[a.band].fR, BANDS[a.band].fD];
    default: return [];
  }
};

/**
 * Render the description's play actions into one signal. Every action's level
 * is clamped to `cap` (the device's own ceiling, at most the description's
 * limit already checked by `validate`); `clipped` reports whether any was.
 * Frequencies above 0.46·fs — where converters' anti-alias filters start —
 * are an Error: `fs` is a property of the device, not of the description.
 */
export function render(desc, fs, { cap = LIMITS.maxLevel } = {}) {
  const expanded = expand(desc);
  const seconds = span(expanded);
  const signal = new Float32Array(Math.ceil(seconds * fs));
  let clipped = false;
  const limit = NYQUIST_USE * fs;
  eachAction(expanded, (a, t) => {
    for (const f of frequenciesOf(a)) {
      if (!(f < limit)) throw new Error(`${a.do} at ${f} Hz does not fit ${fs} Hz audio (needs below 0.46·fs = ${limit} Hz)`);
    }
    const level = Math.min(a.level ?? 0, cap);
    if (a.level !== undefined && level < a.level) clipped = true;
    let piece = null;
    if (a.do === 'tone') {
      const n = Math.round(a.seconds * fs);
      piece = new Float32Array(n);
      const hz = a.hz ?? (a.which === 'D' ? BANDS[a.band].fD : BANDS[a.band].fR);
      const w = (2 * Math.PI * hz) / fs;
      const ramp = Math.round(a.ramp * fs);
      for (let i = 0; i < n; i++) piece[i] = level * edgeGain(i, n, ramp) * Math.sin(w * i);
    } else if (a.do === 'chirp') {
      piece = chirpSignal(a, fs);
      if (level < a.level) for (let i = 0; i < piece.length; i++) piece[i] *= level / a.level;
    } else if (a.do === 'noise') {
      piece = noiseSignal(a, fs);
      if (level < a.level) for (let i = 0; i < piece.length; i++) piece[i] *= level / a.level;
    } else if (a.do === 'frame') {
      piece = renderFrame(a, fs);
      if (level < a.level) for (let i = 0; i < piece.length; i++) piece[i] *= level / a.level;
    }
    if (!piece) return;
    const k0 = Math.round(t * fs);
    for (let i = 0; i < piece.length && k0 + i < signal.length; i++) signal[k0 + i] += piece[i];
  });
  return { signal, seconds, clipped };
}

/* ------------------------------------------------------------------ */
/* summaries                                                           */
/* ------------------------------------------------------------------ */

/**
 * Hann-windowed Goertzel amplitude of `hz` over `n` samples starting at `k0`,
 * scaled so a steady sine of amplitude A reads A — bandtest.js toneLevel
 * generalised to any window length.
 */
export function goertzelAmplitude(rec, fs, hz, k0, n) {
  if (n < 2) return Math.abs(rec[k0] || 0);
  const w = (2 * Math.PI * hz) / fs;
  const c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0, sum = 0;
  for (let k = 0; k < n; k++) {
    const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1));
    sum += h;
    const s0 = h * (rec[k0 + k] || 0) + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const re = s1 - s2 * Math.cos(w);
  const im = s2 * Math.sin(w);
  return (2 * Math.hypot(re, im)) / sum;
}

// Floored where the band-test report floors (−127 dBFS): JSON has no −Infinity.
const dbfs = (rms) => Math.max(-127, rms > 0 ? 20 * Math.log10(rms) : -127);

function summarizeLevels(rec, fs, win) {
  let peak = 0, sum = 0;
  for (const v of rec) { const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; }
  const rms = Math.sqrt(sum / (rec.length || 1));
  const n = Math.max(1, Math.round(win * fs));
  const series = [];
  for (let k0 = 0; k0 < rec.length; k0 += n) {
    let s = 0, m = 0;
    for (let k = k0; k < Math.min(k0 + n, rec.length); k++) { s += rec[k] * rec[k]; m++; }
    series.push({ t: k0 / fs, rms: Math.sqrt(s / m) });
  }
  return { peak, rms, dbfs: dbfs(rms), series };
}

function summarizeGoertzel(a, rec, fs, win) {
  const hz = a.hz ?? Object.keys(BANDS).flatMap((b) => [BANDS[b].fR, BANDS[b].fD]);
  const n = Math.max(2, Math.round(win * fs));
  return hz.map((f) => ({
    hz: f,
    amplitude: goertzelAmplitude(rec, fs, f, 0, rec.length),
    series: Array.from({ length: Math.ceil(rec.length / n) },
      (_, i) => goertzelAmplitude(rec, fs, f, i * n, Math.min(n, rec.length - i * n))),
  }));
}

function summarizeSpectrum(a, rec, fs) {
  const bins = a.bins ?? 256;
  const hz = [], db = [];
  for (let i = 0; i < bins; i++) {
    const f = ((i + 1) * NYQUIST_USE * fs) / bins;
    hz.push(f);
    db.push(Math.max(-127, dbfs(goertzelAmplitude(rec, fs, f, 0, rec.length))));
  }
  return { hz, db };
}

function summarizeEdges(a, rec, fs, win) {
  const { fR, fD } = BANDS[a.band ?? 'A'];
  const thetaD = a.thetaD ?? DETECTOR_DEFAULTS.thetaD;
  const floor = a.floor ?? 0.01;
  const n = Math.max(2, Math.round(win * fs));
  const out = [];
  let last = null;
  for (let k0 = 0; k0 < rec.length; k0 += n) {
    const m = Math.min(n, rec.length - k0);
    const aR = goertzelAmplitude(rec, fs, fR, k0, m);
    const aD = goertzelAmplitude(rec, fs, fD, k0, m);
    const level = Math.hypot(aR, aD) < floor ? 'idle'
      : (aD * aD) / (aR * aR + aD * aD) >= thetaD ? 'D' : 'R';
    if (level !== last) { out.push({ t: k0 / fs, level }); last = level; }
  }
  return out;
}

/**
 * The summary one `record` action asks for: one key per requested kind. `wav`
 * is only a note — the page uploads the samples themselves.
 */
export function summarize(a, rec, fs) {
  const win = a.window;
  const out = {};
  for (const kind of a.return ?? ['levels']) {
    if (kind === 'wav') out.wav = { samples: rec.length, seconds: rec.length / fs };
    else if (kind === 'levels') out.levels = summarizeLevels(rec, fs, win ?? 0.1);
    else if (kind === 'goertzel') out.goertzel = summarizeGoertzel(a, rec, fs, win ?? 0.1);
    else if (kind === 'spectrum') out.spectrum = summarizeSpectrum(a, rec, fs);
    else if (kind === 'edges') out.edges = summarizeEdges(a, rec, fs, win ?? 0.01);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* measures                                                            */
/* ------------------------------------------------------------------ */

/**
 * Where `chirp` arrives in `rec`: the lag of the best normalised
 * cross-correlation peak, searched over 0..1 s — spec/rig.md §3.3.
 */
export function latencyOf(rec, fs, chirp, maxDelay = 1.0) {
  let cc = 0;
  for (const v of chirp) cc += v * v;
  const lags = Math.min(Math.round(maxDelay * fs), rec.length - chirp.length + 1);
  let best = 0, bestLag = 0;
  for (let lag = 0; lag < lags; lag++) {
    let dot = 0, xx = 0;
    for (let k = 0; k < chirp.length; k++) { const v = rec[lag + k]; dot += v * chirp[k]; xx += v * v; }
    const r = xx > 0 && cc > 0 ? dot / Math.sqrt(xx * cc) : 0;
    if (r > best) { best = r; bestLag = lag; }
  }
  return { ms: (bestLag / fs) * 1000, peak: best };
}

/** A quiet recording's level, and what little it holds at each band's tones. */
export function noiseOf(rec, fs) {
  let sum = 0;
  for (const v of rec) sum += v * v;
  const bands = {};
  for (const b of Object.keys(BANDS)) {
    bands[b] = [BANDS[b].fR, BANDS[b].fD].map((f) => goertzelAmplitude(rec, fs, f, 0, rec.length));
  }
  return { dbfs: dbfs(Math.sqrt(sum / (rec.length || 1))), bands };
}
