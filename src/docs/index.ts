/** The document viewer's host side (docs/DOCUMENTS.md, docs/COURSE_DOCS.md): what src/index.ts, the portal and the voice side import. */
export { createDocs, titleFrom, kindOfBytes, looksLikeOldOffice, DOC_GATE } from './docs.js';
export type { DocsDeps } from './docs.js';
export { DocStore, cleanMeta } from './store.js';
export { createRenderer, renderContainerSpec, DOC_IMAGE, OFFICE_RENDER_LIMITS, RENDER_LIMITS } from './render.js';
export { cleanDocName, isUploadName, listUploadDocuments, nameableDocs, resolveDocName } from './resolve.js';
export type { DocChoice } from './resolve.js';
export { startDocOpen, DOC_ANSWER_CHARS } from './ipc-verb.js';
export type { DocVerbEnv, DocVerbInput } from './ipc-verb.js';
export { handleCourseDocFind } from './library-verb.js';
export type { CourseDocVerbEnv, CourseDocVerbInput } from './library-verb.js';
export { LIBRARY_ANSWER_CHARS, slidesAnswer } from './library-answer.js';
export { LibrarySearcher, buildIndex, searchLibrary } from './library-search.js';
export { createLibraryAdmin } from './library.js';
export type { LibraryAdmin } from './library.js';
export * from './types.js';
