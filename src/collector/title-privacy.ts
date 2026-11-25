// What part of a window title may be stored.
//
// Titles are only needed to classify the window, which happens before storing.
// Outside browsers a title is often personal text: the first line of an
// untitled Notepad note, a chat partner's name in KakaoTalk, a document name.
// So only browser titles are kept (the extension stores the same tab titles
// anyway), and a browser showing a local document has its file name replaced
// by the extension alone, as the browser monitor does for file:// URLs.

const BROWSER_APP = /chrome|chromium|edge|whale|brave|opera|vivaldi|firefox/i;

const DOC_EXTENSIONS = [
  "pdf", "doc", "docx", "hwp", "hwpx", "ppt", "pptx", "xls", "xlsx",
  "txt", "md", "csv", "rtf", "odt", "jpg", "jpeg", "png", "gif", "webp", "svg",
];

// "강의.pdf - 개인 - Microsoft Edge", "*메모.pdf - Microsoft Edge",
// "사진.png (1920×1080) - Google Chrome": the file name starts the title.
const LOCAL_FILE_TITLE = new RegExp(`^\\*?[^\\\\/]*?\\.(${DOC_EXTENSIONS.join("|")})(?=$|[\\s)])`, "i");

export function isBrowserApp(app: string | null | undefined): boolean {
  return !!app && BROWSER_APP.test(app);
}

/** The title to store for a window of `app`, or undefined to store none. */
export function storableTitle(app: string | null | undefined, title: string | null | undefined): string | undefined {
  if (!title || !isBrowserApp(app)) return undefined;
  const m = LOCAL_FILE_TITLE.exec(title);
  return m ? `local.${m[1]!.toLowerCase()}` : title;
}
