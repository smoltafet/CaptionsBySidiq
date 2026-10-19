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

export function transcriptionItemsToSrt(items) {
  return itemsToCues(items, secondsToSrtTimestamp);
}

/**
 * Format the same caption items as WebVTT, for use with the native
 * <track> element. VTT timestamps use a '.' millisecond separator.
 */
export function transcriptionItemsToVtt(items) {
  const cues = itemsToCues(
    items,
    (time) => secondsToSrtTimestamp(time).replace(',', '.')
  );
  return 'WEBVTT\n\n' + cues;
}
