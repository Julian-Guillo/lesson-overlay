importScripts('shared.js');
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const id = LessonOverlay.lessonId(sender.url);
  if (
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    !id ||
    message?.type !== 'lesson-timings' ||
    message.lesson !== id
  )
    return false;
  (async () => {
    try {
      const response = await fetch(chrome.runtime.getURL(`timings/lessons/${id}.json`));
      if (!response.ok) throw Error('missing');
      const body = await response.text();
      if (body.length > 4_000_000) throw Error('oversized');
      sendResponse({ ok: true, data: LessonOverlay.validate(JSON.parse(body), id) });
    } catch {
      sendResponse({
        ok: false,
        error: `No valid timings for ${id}. Copy the private timings folder into this extension, reload it, then refresh this lesson.`,
      });
    }
  })();
  return true;
});
