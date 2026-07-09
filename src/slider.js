// Target-distance slider + out-and-back mirroring.
// In out-and-back mode the displayed track is derived: the outbound track
// truncated at target/2 and mirrored home. The slider moves the turnaround.

import { haversineM } from './router.js';
import { M_PER_MI } from './route.js';

// Cut a track at a given distance (meters), interpolating the final point.
export function truncateTrack(coords, cutM) {
  if (coords.length < 2) return coords.slice();
  const out = [coords[0]];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const seg = haversineM(coords[i - 1], coords[i]);
    if (acc + seg >= cutM) {
      const t = seg === 0 ? 0 : (cutM - acc) / seg;
      const a = coords[i - 1];
      const b = coords[i];
      out.push([
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        (a[2] ?? 0) + ((b[2] ?? 0) - (a[2] ?? 0)) * t,
      ]);
      return out;
    }
    acc += seg;
    out.push(coords[i]);
  }
  return out; // track shorter than cut distance
}

export function outAndBack(coords, targetMi) {
  const half = (targetMi * M_PER_MI) / 2;
  const outbound = truncateTrack(coords, half);
  const back = outbound.slice(0, -1).reverse();
  return outbound.concat(back);
}
