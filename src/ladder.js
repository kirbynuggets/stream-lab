/**
 * The bitrate ladder: which renditions we encode, and why.
 *
 * Numbers follow Apple's HLS authoring advice and the usual streaming-industry
 * ladders. Keeping the ladder in one data file (rather than buried in ffmpeg
 * flags) means the packager, the manifest writer and the tests all agree.
 *
 * Every rendition shares:
 *   - the same keyframe cadence, so a player can switch at any segment boundary
 *   - the same segment duration, so segment N covers the same seconds everywhere
 *   - the same audio, muxed into each variant (simplest interoperable choice)
 */

export const SEGMENT_SECONDS = 4;       // 2-6s is the usual trade-off: smaller = faster switching, more requests
export const GOP_SECONDS = SEGMENT_SECONDS;

/** height, video kbps, audio kbps, x264 profile. Ordered low to high. */
// One profile for the whole ladder. Mixing baseline/main/high across rungs is
// legal HLS but makes mid-stream switching fragile: a MediaSource configured for
// one profile can hit a decode error when a different one shows up. Every device
// that matters supports High, so every rung uses it.
export const LADDER = [
  { name: '240p',  height: 240,  vkbps: 400,   akbps: 64,  profile: 'high', level: '3.0' },
  { name: '360p',  height: 360,  vkbps: 800,   akbps: 96,  profile: 'high', level: '3.1' },
  { name: '540p',  height: 540,  vkbps: 1600,  akbps: 128, profile: 'high', level: '3.1' },
  { name: '720p',  height: 720,  vkbps: 3000,  akbps: 128, profile: 'high', level: '4.0' },
  { name: '1080p', height: 1080, vkbps: 5500,  akbps: 160, profile: 'high', level: '4.1' },
];

/** Renditions that make sense for a source of this height (never upscale). */
export function ladderFor(sourceHeight) {
  const fits = LADDER.filter((r) => r.height <= sourceHeight + 16);
  return fits.length ? fits : [LADDER[0]];
}

/**
 * Dimensions that preserve the aspect ratio, with the width aligned to a
 * macroblock (16px). Even numbers are enough for H.264 on paper, but widths like
 * 426 (16:9 at 240p) are not macroblock-aligned and made Apple's hardware decoder
 * fail with kVTVideoDecoderBadDataErr on mid-stream resolution changes. Aligning
 * to 16 costs ~1% of aspect accuracy and removes the whole class of bug.
 */
export function scaleTo(srcW, srcH, targetH) {
  const h = Math.min(targetH, srcH) - (Math.min(targetH, srcH) % 2);
  const exact = (srcW * h) / srcH;
  let w = Math.round(exact / 16) * 16;
  if (w < 16) w = 16;
  if (Math.abs(w - exact) / exact > 0.03) w = Math.round(exact / 2) * 2;   // keep aspect if 16-alignment would distort
  return { width: w, height: h };
}

/** RFC 6381 codec string, which lets players reject streams they cannot decode. */
export function codecString(profile, level) {
  const profileHex = { baseline: '42', main: '4D', high: '64' }[profile] || '4D';
  const levelHex = Math.round(parseFloat(level) * 10).toString(16).padStart(2, '0').toUpperCase();
  return `avc1.${profileHex}00${levelHex},mp4a.40.2`;
}

export const totalKbps = (r) => r.vkbps + r.akbps;
