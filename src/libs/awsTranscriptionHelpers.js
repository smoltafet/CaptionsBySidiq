// Helpers for converting AWS Transcribe output into caption formats.
//
// AWS Transcribe returns one item per word ("pronunciation" items, which
// carry start/end times) plus "punctuation" items, which have no times
// and belong to the word before them. The editor and the SRT/VTT
// exporters all work with the cleaned shape produced here:
// { start_time, end_time, content }.

/**
 * Merge punctuation items into the word they follow and return a dense
 * array of timed caption items.
 *
 * The previous implementation mutated the input with `delete`, which
 * left holes in the array (inflating its length for consumers) and
 * crashed with a TypeError when the first item was punctuation, because
 * there is no previous item to merge into. This version is pure, always
 * returns a dense array, and handles leading punctuation by prefixing
 * it to the first following word.
 */
export function clearTranscriptionItems(items) {
  const cleaned = [];
  let leadingPunctuation = '';

  for (const item of items || []) {
    const content = item?.alternatives?.[0]?.content;
    if (content == null) {
      continue;
    }

    if (item.start_time == null) {
      // Punctuation: attach to the previous word, or buffer it as a
      // prefix when no word has been seen yet.
      if (cleaned.length > 0) {
        cleaned[cleaned.length - 1].content += content;
      } else {
        leadingPunctuation += content;
      }
      continue;
    }

    cleaned.push({
      start_time: item.start_time,
      end_time: item.end_time,
      content: leadingPunctuation + content,
    });
    leadingPunctuation = '';
  }

  return cleaned;
}

/**
 * Format a time in seconds as an SRT timestamp: HH:MM:SS,mmm
 *
 * Computed arithmetically instead of via Date/toISOString, which
 * throws a RangeError for invalid dates and wraps around at 24 hours.
 * Non-numeric input formats as zero instead of crashing the export.
 */
export function secondsToSrtTimestamp(time) {
  const totalSeconds = Number.parseFloat(time);
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return '00:00:00,000';
  }

  // Round once to whole milliseconds so a value like 59.9999s carries
  // into the seconds column instead of printing ",1000".
  let remainingMs = Math.round(totalSeconds * 1000);
  const hours = Math.floor(remainingMs / 3_600_000);
  remainingMs %= 3_600_000;
  const minutes = Math.floor(remainingMs / 60_000);
  remainingMs %= 60_000;
  const seconds = Math.floor(remainingMs / 1000);
  const milliseconds = remainingMs % 1000;

  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(milliseconds, 3)}`;
}

/**
 * Readability limits for grouped cues. Caption files with one cue per
 * word are technically valid but painful to read in a player and to
 * scan in an editor, so the exporters group words into phrase-sized
 * cues. A new cue starts when any limit would be exceeded, when the
 * pause before the next word is long, or at a sentence boundary.
 */
export const DEFAULT_CUE_LIMITS = {
  maxCharacters: 84,
  maxDurationSeconds: 7,
  maxWords: 14,
  maxGapSeconds: 1.2,
};

const SENTENCE_END = /[.!?…]["')\]]?$/;

function toSeconds(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Group timed word items ({start_time, end_time, content}) into
 * readable cues of the same shape. Pure: the input items are not
 * mutated, and cue times always satisfy start <= end.
 */
export function groupItemsIntoCues(items, limits) {
  const {
    maxCharacters,
    maxDurationSeconds,
    maxWords,
    maxGapSeconds,
  } = {...DEFAULT_CUE_LIMITS, ...(limits || {})};

  const cues = [];
  let cue = null;

  const flush = () => {
    if (cue) {
      cues.push(cue);
      cue = null;
    }
  };

  for (const item of items || []) {
    const content = typeof item?.content === 'string' ? item.content.trim() : '';
    const start = toSeconds(item?.start_time);
    if (!content || start == null) {
      continue;
    }
    const parsedEnd = toSeconds(item?.end_time);
    const end = parsedEnd != null && parsedEnd >= start ? parsedEnd : start;

    if (cue) {
      const joinedLength = cue.content.length + 1 + content.length;
      const breaksCue =
        start - cue.endSeconds > maxGapSeconds
        || end - cue.startSeconds > maxDurationSeconds
        || cue.wordCount >= maxWords
        || joinedLength > maxCharacters
        || SENTENCE_END.test(cue.content);
      if (breaksCue) {
        flush();
      }
    }

    if (!cue) {
      cue = {
        start_time: String(start),
        end_time: String(end),
        content,
        startSeconds: start,
        endSeconds: end,
        wordCount: 1,
      };
    } else {
      cue.content += ' ' + content;
      cue.end_time = String(end);
      cue.endSeconds = end;
      cue.wordCount += 1;
    }
  }
  flush();

  // Strip the internal bookkeeping fields from the result.
  return cues.map(({start_time, end_time, content}) => ({
    start_time,
    end_time,
    content,
  }));
}

/**
 * Minimum cue length, in seconds, used when an item has no usable end
 * time and no following item to borrow one from.
 */
export const MIN_CUE_DURATION_SECONDS = 0.1;

/**
 * Normalize timed caption items into a clean, export-safe timeline:
 *
 *   - items are sorted by start time (edits in the transcription
 *     editor can leave them out of order, and both exporters and the
 *     cue grouper assume chronological input);
 *   - items with no text or no usable start time are dropped;
 *   - a missing or inverted end time is repaired from the next item's
 *     start, or a minimum duration when there is no next item;
 *   - overlaps are resolved by trimming the earlier item's end to the
 *     next item's start. If trimming would make the earlier item
 *     zero-length, its text is merged into the next item instead of
 *     being silently lost.
 *
 * Pure: the input items are not mutated. Times in the result are
 * strings, matching the shape the rest of this module produces.
 */
export function normalizeCaptionItems(items) {
  const parsed = [];
  for (const item of items || []) {
    const content = typeof item?.content === 'string' ? item.content.trim() : '';
    const start = toSeconds(item?.start_time);
    if (!content || start == null) {
      continue;
    }
    parsed.push({ start, end: toSeconds(item?.end_time), content });
  }
  parsed.sort((a, b) => a.start - b.start || (a.end ?? a.start) - (b.end ?? b.start));

  const normalized = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    let { end } = item;
    if (end == null || end <= item.start) {
      const nextStart = i + 1 < parsed.length ? parsed[i + 1].start : null;
      end = nextStart != null && nextStart > item.start
        ? nextStart
        : item.start + MIN_CUE_DURATION_SECONDS;
    }

    const previous = normalized[normalized.length - 1];
    if (previous && item.start < previous.end) {
      if (item.start > previous.start) {
        previous.end = item.start;
      } else {
        // Trimming would erase the previous item: fold its text into
        // this one (which starts no later) and drop the empty shell.
        item.content = `${previous.content} ${item.content}`;
        normalized.pop();
      }
    }
    normalized.push({ start: item.start, end, content: item.content });
  }

  return normalized.map(({ start, end, content }) => ({
    start_time: String(start),
    end_time: String(end),
    content,
  }));
}

/**
 * Shift every item's timings by `offsetSeconds` (negative shifts
 * earlier). Used to re-sync captions against a video whose start was
 * trimmed. Items that would end at or before zero are dropped; items
 * straddling zero are clamped to start at zero. Pure.
 */
export function shiftCaptionItems(items, offsetSeconds) {
  const offset = Number.parseFloat(offsetSeconds);
  if (!Number.isFinite(offset) || offset === 0) {
    return normalizeCaptionItems(items);
  }
  const shifted = [];
  for (const item of normalizeCaptionItems(items)) {
    const start = Number.parseFloat(item.start_time) + offset;
    const end = Number.parseFloat(item.end_time) + offset;
    if (end <= 0) {
      continue;
    }
    shifted.push({
      start_time: String(Math.max(0, start)),
      end_time: String(end),
      content: item.content,
    });
  }
  return shifted;
}

/**
 * Multiply every item's timings by `factor`, for re-timing a track
 * against a version of the video that plays at a different speed:
 * the classic case is a frame-rate conversion (23.976 fps to 25 fps
 * needs a factor of about 0.959), and a screen recording re-exported
 * at 1.25x needs 0.8. Shift handles a moved start point; this handles
 * a stretched or compressed timeline, where a fixed offset would
 * drift further off the longer the video runs.
 *
 * Times are rounded to whole milliseconds, the precision the SRT/VTT
 * exporters print, so re-exporting a rescaled track does not accumulate
 * float dust. A non-positive or non-numeric factor is not a usable
 * speed change, so the normalized track is returned unchanged. Pure.
 */
export function rescaleCaptionTimings(items, factor) {
  const scale = Number.parseFloat(factor);
  const normalized = normalizeCaptionItems(items);
  if (!Number.isFinite(scale) || scale <= 0 || scale === 1) {
    return normalized;
  }
  const roundMs = (seconds) => Math.round(seconds * scale * 1000) / 1000;
  return normalized.map((item) => {
    const start = roundMs(Number.parseFloat(item.start_time));
    let end = roundMs(Number.parseFloat(item.end_time));
    if (end <= start) {
      end = Math.round((start + MIN_CUE_DURATION_SECONDS) * 1000) / 1000;
    }
    return {
      start_time: String(start),
      end_time: String(end),
      content: item.content,
    };
  });
}

function itemsToCues(items, formatTimestamp) {
  let output = '';
  let i = 1;
  for (const item of items || []) {
    if (!item) {
      continue;
    }
    output += i + "\n";
    output += formatTimestamp(item.start_time)
      + ' --> '
      + formatTimestamp(item.end_time)
      + "\n";
    output += item.content + "\n";
    output += "\n";
    i++;
  }
  return output;
}

/**
 * Export items as SRT. By default words are grouped into readable
 * cues (see groupItemsIntoCues); pass {groupCues: false} for the raw
 * one-cue-per-word output the word-by-word burn-in rendering uses.
 */
export function transcriptionItemsToSrt(items, options) {
  const normalized = normalizeCaptionItems(items);
  const cues = options?.groupCues === false
    ? normalized
    : groupItemsIntoCues(normalized, options?.cueLimits);
  return itemsToCues(cues, secondsToSrtTimestamp);
}

/**
 * Format the same caption items as WebVTT, for use with the native
 * <track> element. VTT timestamps use a '.' millisecond separator.
 */
export function transcriptionItemsToVtt(items, options) {
  const normalized = normalizeCaptionItems(items);
  const grouped = options?.groupCues === false
    ? normalized
    : groupItemsIntoCues(normalized, options?.cueLimits);
  const cues = itemsToCues(
    grouped,
    (time) => secondsToSrtTimestamp(time).replace(',', '.')
  );
  return 'WEBVTT\n\n' + cues;
}

/**
 * Readability limits for caption quality analysis. These mirror the
 * grouping limits above plus delivery rules used by broadcast
 * captioning: text shown faster than ~20 characters per second is hard
 * to read, and cues shorter than ~0.8s flash by before they register.
 */
export const DEFAULT_QUALITY_LIMITS = {
  maxCharsPerSecond: 20,
  minDurationSeconds: 0.8,
  maxDurationSeconds: 7,
  maxCharacters: 84,
  maxWordsPerCue: 14,
};

/**
 * Analyze one grouped cue: its timing, reading speed, and any
 * readability issues. Issue codes are stable strings so the editor can
 * count and label them: 'too-fast', 'too-short', 'too-long',
 * 'too-many-chars', 'too-many-words'.
 */
export function analyzeCaptionCue(cue, index, limits) {
  const resolved = {...DEFAULT_QUALITY_LIMITS, ...(limits || {})};
  const start = toSeconds(cue?.start_time) ?? 0;
  const parsedEnd = toSeconds(cue?.end_time);
  const end = parsedEnd != null && parsedEnd >= start ? parsedEnd : start;
  const durationSeconds = end - start;
  const content = typeof cue?.content === 'string' ? cue.content.trim() : '';
  const characters = content.length;
  const words = content === '' ? 0 : content.split(/\s+/).length;
  const charsPerSecond = durationSeconds > 0
    ? characters / durationSeconds
    : (characters > 0 ? Number.POSITIVE_INFINITY : 0);

  const issues = [];
  if (charsPerSecond > resolved.maxCharsPerSecond) {
    issues.push('too-fast');
  }
  if (durationSeconds < resolved.minDurationSeconds) {
    issues.push('too-short');
  }
  if (durationSeconds > resolved.maxDurationSeconds) {
    issues.push('too-long');
  }
  if (characters > resolved.maxCharacters) {
    issues.push('too-many-chars');
  }
  if (words > resolved.maxWordsPerCue) {
    issues.push('too-many-words');
  }

  return {
    index,
    start_time: cue?.start_time,
    end_time: cue?.end_time,
    content,
    durationSeconds,
    characters,
    words,
    charsPerSecond,
    issues,
  };
}

/**
 * Score a whole caption track's readability, 0-100.
 *
 * The track is normalized and grouped into cues first (the same cues
 * the exporters emit), each cue is analyzed, and the score starts at
 * 100 with a penalty per issue scaled by how much of the track it
 * affects: an issue on every cue costs far more than one bad cue in a
 * long video. Returns the per-cue analyses too, so the editor can
 * point at exactly which cues need work.
 */
export function summarizeCaptionQuality(items, limits) {
  const normalized = normalizeCaptionItems(items);
  const cues = groupItemsIntoCues(normalized, limits);
  const analyses = cues.map((cue, index) => analyzeCaptionCue(cue, index, limits));

  const issueCounts = {};
  let cuesWithIssues = 0;
  let worstCharsPerSecond = 0;
  let totalCharsPerSecond = 0;
  let totalDurationSeconds = 0;
  for (const analysis of analyses) {
    if (analysis.issues.length > 0) {
      cuesWithIssues += 1;
    }
    for (const issue of analysis.issues) {
      issueCounts[issue] = (issueCounts[issue] || 0) + 1;
    }
    if (Number.isFinite(analysis.charsPerSecond)) {
      worstCharsPerSecond = Math.max(worstCharsPerSecond, analysis.charsPerSecond);
      totalCharsPerSecond += analysis.charsPerSecond;
    }
    totalDurationSeconds += analysis.durationSeconds;
  }

  const cueCount = analyses.length;
  const totalIssues = Object.values(issueCounts).reduce((sum, n) => sum + n, 0);
  // Penalty is 40 points per issue-per-cue on average: a track where
  // every cue has exactly one issue scores 60, stacked issues push it
  // lower, and clean tracks stay at 100.
  const penalty = cueCount === 0 ? 0 : Math.min(100, (totalIssues / cueCount) * 40);
  const score = Math.round(100 - penalty);

  return {
    score,
    cueCount,
    wordCount: analyses.reduce((sum, a) => sum + a.words, 0),
    cuesWithIssues,
    issueCounts,
    totalIssues,
    averageCharsPerSecond: cueCount === 0 ? 0 : totalCharsPerSecond / cueCount,
    worstCharsPerSecond,
    totalDurationSeconds,
    analyses,
  };
}

/**
 * Parse one caption timestamp ("00:01:02,500" SRT style or
 * "00:01:02.500" / "01:02.500" VTT style) into seconds. Returns null
 * for anything that is not a well-formed timestamp: the hour field is
 * optional, minutes/seconds must be two digits, and the fractional
 * part is 1-3 digits interpreted as milliseconds.
 */
export function parseCaptionTimestamp(text) {
  if (typeof text !== 'string') {
    return null;
  }
  const match = text.trim().match(/^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{1,3})$/);
  if (!match) {
    return null;
  }
  const hours = match[1] ? Number.parseInt(match[1], 10) : 0;
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseInt(match[3], 10);
  if (minutes > 59 || seconds > 59) {
    return null;
  }
  const millis = Number.parseInt(match[4].padEnd(3, '0'), 10);
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

const TIMING_LINE = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/;

/**
 * Parse the cue blocks of an SRT or WebVTT document into timed items
 * of the same {start_time, end_time, content} shape the exporters
 * consume, so a caption file can be imported, edited, and re-exported
 * losslessly. start_time/end_time are strings with three decimals,
 * matching what AWS Transcribe produces.
 *
 * Deliberately forgiving, the way real-world caption files are messy:
 * an optional numeric SRT index or VTT cue identifier line is
 * skipped, a leading "WEBVTT" header (and any NOTE/STYLE/REGION
 * blocks in VTT) are ignored, cue settings after the end timestamp
 * are dropped, multi-line cue text is joined with spaces, inline tags
 * like <i> are preserved in the text, CRLF and stray blank lines are
 * tolerated, and blocks whose timing line does not parse are skipped
 * rather than aborting the whole import. Items come back normalized
 * (sorted, overlaps repaired) via normalizeCaptionItems.
 */
export function parseCaptionText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return [];
  }
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const blocks = normalized.split(/\n\s*\n/);
  const items = [];

  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    if (lines.length === 0) {
      continue;
    }
    // Skip the VTT header and metadata blocks.
    if (/^WEBVTT($|\s)/.test(lines[0]) || /^(NOTE|STYLE|REGION)($|\s)/.test(lines[0])) {
      continue;
    }
    // Find the timing line: it is the first line when there is no
    // index/identifier, the second when there is one.
    let timingIndex = lines.findIndex((line) => TIMING_LINE.test(line));
    if (timingIndex === -1 || timingIndex > 1) {
      continue;
    }
    const timing = lines[timingIndex].match(TIMING_LINE);
    const start = parseCaptionTimestamp(timing[1]);
    const end = parseCaptionTimestamp(timing[2]);
    if (start == null || end == null || end < start) {
      continue;
    }
    const content = lines.slice(timingIndex + 1).join(' ').trim();
    if (content === '') {
      continue;
    }
    items.push({
      start_time: start.toFixed(3),
      end_time: end.toFixed(3),
      content,
    });
  }

  return normalizeCaptionItems(items);
}

/** Parse an SRT document into timed caption items. */
export function srtToTranscriptionItems(text) {
  return parseCaptionText(text);
}

/** Parse a WebVTT document into timed caption items. */
export function vttToTranscriptionItems(text) {
  return parseCaptionText(text);
}

/**
 * Find the grouped cue showing at a given playback time, for
 * click-to-seek highlighting in the editor. Returns the cue (the same
 * grouped shape the exporters emit) plus its index, or null when the
 * time falls in a gap or outside the track. A time exactly at a cue's
 * end belongs to the next cue when one starts there.
 */
export function findCueAtTime(items, timeSeconds) {
  const time = toSeconds(timeSeconds);
  if (time == null) {
    return null;
  }
  const cues = groupItemsIntoCues(normalizeCaptionItems(items));
  for (let index = 0; index < cues.length; index++) {
    const start = toSeconds(cues[index].start_time) ?? 0;
    const end = toSeconds(cues[index].end_time) ?? start;
    if (time >= start && time < end) {
      return { index, cue: cues[index] };
    }
  }
  return null;
}

/**
 * Escape a string for literal use inside a RegExp.
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find every occurrence of `query` in the caption text, case
 * insensitively. Transcriptions routinely get the same name or term
 * wrong the same way throughout, and until now the only way to find
 * each occurrence was to read the whole track. Returns one entry per
 * occurrence: the index into the normalized item list, that item's
 * times and text, and where in the text the match starts, so the
 * editor can jump to and highlight occurrences. An empty or
 * whitespace-only query matches nothing.
 */
export function searchCaptionItems(items, query) {
  const needle = typeof query === 'string' ? query.trim() : '';
  if (needle === '') {
    return [];
  }
  const pattern = new RegExp(escapeRegExp(needle), 'gi');
  const matches = [];
  const normalized = normalizeCaptionItems(items);
  normalized.forEach((item, index) => {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(item.content)) !== null) {
      matches.push({
        index,
        start_time: item.start_time,
        end_time: item.end_time,
        content: item.content,
        matchIndex: match.index,
        matchLength: match[0].length,
      });
      // A zero-length match cannot happen for a non-empty needle,
      // but never loop forever if the pattern is ever changed.
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
      }
    }
  });
  return matches;
}

/**
 * Replace every case-insensitive occurrence of `query` across the
 * whole track and return the new, normalized items. Pure: the input
 * items are not mutated, so the editor can keep the old state for
 * undo. The replacement is inserted literally ($ sequences are not
 * treated as substitution patterns). Items left with no text after
 * the replacement are dropped by the final normalization, and the
 * result keeps chronological order.
 */
export function replaceCaptionText(items, query, replacement) {
  const needle = typeof query === 'string' ? query : '';
  const normalized = normalizeCaptionItems(items);
  if (needle.trim() === '') {
    return normalized;
  }
  const pattern = new RegExp(escapeRegExp(needle), 'gi');
  const literal = typeof replacement === 'string' ? replacement : '';
  const replaced = normalized.map((item) => ({
    ...item,
    content: item.content.replace(pattern, () => literal).replace(/\s{2,}/g, ' ').trim(),
  }));
  return normalizeCaptionItems(replaced);
}

export const DEFAULT_PLAINTEXT_OPTIONS = {
  // A silence longer than this between two cues starts a new
  // paragraph in the plain-text transcript.
  paragraphPauseSeconds: 1.5,
};

/**
 * Render the track as a plain-text transcript: the grouped cues'
 * words in order, split into paragraphs wherever the speaker pauses
 * for longer than `paragraphPauseSeconds` (default 1.5s). Until now
 * the only downloads were caption files (SRT/VTT), which are awkward
 * to paste into notes, docs, or a description box; this is the
 * readable version of the same track. Paragraphs are joined with a
 * blank line and the result ends with a single trailing newline. An
 * empty or junk-only track yields an empty string.
 */
export function transcriptionItemsToPlainText(items, options) {
  const pauseThreshold =
    options && typeof options.paragraphPauseSeconds === 'number' && options.paragraphPauseSeconds >= 0
      ? options.paragraphPauseSeconds
      : DEFAULT_PLAINTEXT_OPTIONS.paragraphPauseSeconds;
  const cues = groupItemsIntoCues(normalizeCaptionItems(items));
  const paragraphs = [];
  let current = '';
  let previousEnd = null;
  for (const cue of cues) {
    const text = (cue.content || '').trim().replace(/\s{2,}/g, ' ');
    if (text === '') {
      continue;
    }
    const start = toSeconds(cue.start_time) ?? 0;
    const end = toSeconds(cue.end_time) ?? start;
    if (current !== '' && previousEnd !== null && start - previousEnd > pauseThreshold) {
      paragraphs.push(current);
      current = text;
    } else {
      current = current === '' ? text : `${current} ${text}`;
    }
    previousEnd = end;
  }
  if (current !== '') {
    paragraphs.push(current);
  }
  return paragraphs.length === 0 ? '' : `${paragraphs.join('\n\n')}\n`;
}
