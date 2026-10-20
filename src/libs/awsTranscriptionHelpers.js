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
