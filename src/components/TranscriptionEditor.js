import {useState} from "react";
import TranscriptionItem from "@/components/TranscriptionItem";
import {replaceCaptionText, searchCaptionItems, summarizeCaptionQuality} from "@/libs/awsTranscriptionHelpers";

const ISSUE_LABELS = {
  'too-fast': 'reading too fast',
  'too-short': 'flashes by too quickly',
  'too-long': 'on screen too long',
  'too-many-chars': 'too much text',
  'too-many-words': 'too many words',
};

export default function TranscriptionEditor({
  awsTranscriptionItems,
  setAwsTranscriptionItems,
}) {
  // Live readability score for the cues the exporters will emit from
  // these items, so problems surface here instead of in the exported
  // file. Recomputed on every edit; the analysis is cheap and pure.
  const quality = awsTranscriptionItems.length > 0
    ? summarizeCaptionQuality(awsTranscriptionItems)
    : null;
  const topIssue = quality
    ? Object.entries(quality.issueCounts).sort((a, b) => b[1] - a[1])[0]
    : null;

  // Find & replace across the whole track: a name or term the
  // transcription got wrong usually went wrong everywhere, and fixing
  // it item by item is slow and easy to miss one.
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const matchCount = findText.trim() === ''
    ? 0
    : searchCaptionItems(awsTranscriptionItems, findText).length;

  function replaceAll() {
    if (matchCount === 0) {
      return;
    }
    setAwsTranscriptionItems(replaceCaptionText(awsTranscriptionItems, findText, replaceText));
  }

  function updateTranscriptionItem(index, prop, ev) {
    const newAwsItems = [...awsTranscriptionItems];
    const newItem = {...newAwsItems[index]};
    newItem[prop] = ev.target.value;
    newAwsItems[index] = newItem;
    setAwsTranscriptionItems(newAwsItems);
  }

  return (
    <>
      {quality && (
        <div className="flex items-center gap-3 p-2 mb-2 rounded-md bg-violet-900/60 text-sm">
          <span>
            Caption quality: <strong>{quality.score}/100</strong>
          </span>
          <span className="text-violet-200">
            {quality.cueCount} cues · {quality.wordCount} words
          </span>
          {quality.totalIssues === 0 ? (
            <span className="text-emerald-300">No readability issues</span>
          ) : (
            <span className="text-amber-300">
              {quality.cuesWithIssues} of {quality.cueCount} cues need work
              {topIssue && (
                <> — most common: {ISSUE_LABELS[topIssue[0]] || topIssue[0]} ({topIssue[1]})</>
              )}
            </span>
          )}
        </div>
      )}
      {awsTranscriptionItems.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 p-2 mb-2 rounded-md bg-violet-900/60 text-sm">
          <input
            value={findText}
            onChange={(ev) => setFindText(ev.target.value)}
            placeholder="Find in captions"
            className="bg-violet-950/60 rounded px-2 py-1 flex-1 min-w-28"
          />
          <input
            value={replaceText}
            onChange={(ev) => setReplaceText(ev.target.value)}
            placeholder="Replace with"
            className="bg-violet-950/60 rounded px-2 py-1 flex-1 min-w-28"
          />
          <button
            onClick={replaceAll}
            disabled={matchCount === 0}
            className="bg-violet-600 disabled:opacity-40 rounded px-3 py-1">
            Replace all
          </button>
          <span className="text-violet-200">
            {findText.trim() === '' ? '' : `${matchCount} match${matchCount === 1 ? '' : 'es'}`}
          </span>
        </div>
      )}
      <div className="grid grid-cols-3 sticky top-0 bg-violet-800/80 p-2 rounded-md">
        <div>From</div>
        <div>End</div>
        <div>Content</div>
      </div>
      {awsTranscriptionItems.length > 0 && (
        <div className="h-48 sm:h-auto overflow-y-scroll sm:overflow-auto">
          {awsTranscriptionItems.map((item,key) => (
            <div key={key}>
              <TranscriptionItem
                handleStartTimeChange={ev => updateTranscriptionItem(key, 'start_time', ev)}
                handleEndTimeChange={ev => updateTranscriptionItem(key, 'end_time', ev)}
                handleContentChange={ev => updateTranscriptionItem(key, 'content', ev)}
                item={item} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}