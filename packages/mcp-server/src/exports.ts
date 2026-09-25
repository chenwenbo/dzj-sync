/**
 * 公共导出 - 供 CLI 等其他包使用
 */
export { ExtensionBridge } from './ws-bridge.js'
export type { PlatformInfo, SyncResult, RequestMessage, ResponseMessage } from './types.js'
export { loadArticleFile, inlineLocalImages, imageFileToDataUri } from './markdown-file.js'
export type { LoadedFile } from './markdown-file.js'
